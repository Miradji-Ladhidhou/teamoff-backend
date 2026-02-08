/* ============================================================
   EXTENSIONS
   ============================================================ */
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

---

/* ============================================================
   ENUMS MÉTIER
   ============================================================ */
CREATE TYPE entreprise_statut AS ENUM ('active','inactive','suspendue');
CREATE TYPE utilisateur_role AS ENUM ('super_admin','admin_entreprise','manager','employe');
CREATE TYPE utilisateur_statut AS ENUM ('actif','inactif','en_attente');
CREATE TYPE conge_statut AS ENUM ('en_attente_manager','valide_manager','refuse_manager','valide_final','refuse_final');
CREATE TYPE demi_journee AS ENUM ('matin','apres_midi');

---

/* ============================================================
   FUNCTION updated_at
   ============================================================ */
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

---

/* ============================================================
   TABLE entreprise
   ============================================================ */
CREATE TABLE entreprise (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom VARCHAR(255) NOT NULL,
  logo VARCHAR(255),
  politique_conges JSONB NOT NULL DEFAULT '{}',
  parametres JSONB NOT NULL DEFAULT '{}',
  statut entreprise_statut NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_entreprise_updated_at
BEFORE UPDATE ON entreprise
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

---

/* ============================================================
   TABLE utilisateur
   ============================================================ */
CREATE TABLE utilisateur (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id UUID NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  nom VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  role utilisateur_role NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  statut utilisateur_statut NOT NULL DEFAULT 'en_attente',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (id, entreprise_id)
);

CREATE INDEX idx_utilisateur_entreprise ON utilisateur(entreprise_id);
CREATE INDEX idx_utilisateur_role ON utilisateur(entreprise_id, role);

CREATE TRIGGER trg_utilisateur_updated_at
BEFORE UPDATE ON utilisateur
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

---

/* ============================================================
   TABLE conge_type
   ============================================================ */
CREATE TABLE conge_type (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id UUID NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  code VARCHAR(20) NOT NULL,
  libelle VARCHAR(255) NOT NULL,
  quota_annuel NUMERIC,
  demi_journee_autorisee BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (entreprise_id, code)
);

CREATE TRIGGER trg_conge_type_updated_at
BEFORE UPDATE ON conge_type
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

---

/* ============================================================
   TABLE compteur_conges
   ============================================================ */
CREATE TABLE compteur_conges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utilisateur_id UUID NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  conge_type_id UUID NOT NULL REFERENCES conge_type(id),
  annee INTEGER NOT NULL,
  jours_pris NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (utilisateur_id, conge_type_id, annee)
);

CREATE TRIGGER trg_compteur_updated_at
BEFORE UPDATE ON compteur_conges
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

---

/* ============================================================
   TABLE jours_feries
   ============================================================ */
CREATE TABLE jours_feries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id UUID NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  libelle VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (entreprise_id, date)
);

CREATE TRIGGER trg_jours_feries_updated_at
BEFORE UPDATE ON jours_feries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

---

/* ============================================================
   TABLE conge
   ============================================================ */
CREATE TABLE conge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utilisateur_id UUID NOT NULL,
  entreprise_id UUID NOT NULL,
  conge_type_id UUID NOT NULL REFERENCES conge_type(id),
  date_debut DATE NOT NULL,
  date_fin DATE NOT NULL,
  debut_demi_journee demi_journee NOT NULL DEFAULT 'matin',
  fin_demi_journee demi_journee NOT NULL DEFAULT 'apres_midi',
  statut conge_statut NOT NULL DEFAULT 'en_attente_manager',
  commentaire_manager TEXT,
  commentaire_admin TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CHECK (date_fin >= date_debut),
  FOREIGN KEY (utilisateur_id, entreprise_id)
    REFERENCES utilisateur(id, entreprise_id)
    ON DELETE CASCADE
);

CREATE INDEX idx_conge_user ON conge(utilisateur_id);
CREATE INDEX idx_conge_entreprise_statut ON conge(entreprise_id, statut);

CREATE TRIGGER trg_conge_updated_at
BEFORE UPDATE ON conge
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

---

/* ============================================================
   TRIGGER ANTI-CHEVAUCHEMENT
   ============================================================ */
CREATE OR REPLACE FUNCTION check_conge_overlap()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM conge c
    WHERE c.utilisateur_id = NEW.utilisateur_id
      AND c.statut IN ('en_attente_manager','valide_manager','valide_final')
      AND (
        (c.date_debut + CASE c.debut_demi_journee WHEN 'apres_midi' THEN 0.5 ELSE 0 END)
        <
        (NEW.date_fin + CASE NEW.fin_demi_journee WHEN 'apres_midi' THEN 0.5 ELSE 0 END)
      )
      AND (
        (NEW.date_debut + CASE NEW.debut_demi_journee WHEN 'apres_midi' THEN 0.5 ELSE 0 END)
        <
        (c.date_fin + CASE c.fin_demi_journee WHEN 'apres_midi' THEN 0.5 ELSE 0 END)
      )
  ) THEN
    RAISE EXCEPTION 'Chevauchement de congés détecté';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_conge_overlap
BEFORE INSERT OR UPDATE ON conge
FOR EACH ROW EXECUTE FUNCTION check_conge_overlap();

---

/* ============================================================
   TABLE audit_log
   ============================================================ */
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id UUID NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  utilisateur_id UUID REFERENCES utilisateur(id) ON DELETE SET NULL,
  action VARCHAR(255) NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

---

/* ============================================================
   TABLE notification
   ============================================================ */
CREATE TABLE notification (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utilisateur_id UUID NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  entreprise_id UUID NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  type VARCHAR(50),
  message TEXT NOT NULL,
  url VARCHAR(255),
  lu BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

---

/* ============================================================
   VUE CALENDRIER
   ============================================================ */
CREATE VIEW v_conge_calendrier AS
SELECT
  c.id AS conge_id,
  c.utilisateur_id,
  c.entreprise_id,
  ct.code AS type_conge,
  d.jour::date AS date,
  CASE
    WHEN d.jour = c.date_debut AND c.debut_demi_journee = 'apres_midi' THEN 'apres_midi'
    WHEN d.jour = c.date_fin AND c.fin_demi_journee = 'matin' THEN 'matin'
    ELSE 'journee'
  END AS periode,
  c.statut
FROM conge c
JOIN conge_type ct ON ct.id = c.conge_type_id
JOIN LATERAL generate_series(c.date_debut, c.date_fin, interval '1 day') d(jour)
ON TRUE;

---