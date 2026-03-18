/* ============================================================
   EXTENSIONS
============================================================ */
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

---

/* ============================================================
   ENUMS
============================================================ */
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'entreprise_statut') THEN
    CREATE TYPE entreprise_statut AS ENUM ('active','inactive','suspendue');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'utilisateur_role') THEN
    CREATE TYPE utilisateur_role AS ENUM ('super_admin','admin_entreprise','manager','employe');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'utilisateur_statut') THEN
    CREATE TYPE utilisateur_statut AS ENUM ('actif','inactif','en_attente');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conge_statut') THEN
    CREATE TYPE conge_statut AS ENUM ('en_attente_manager','valide_manager','refuse_manager','valide_final','refuse_final');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'demi_journee') THEN
    CREATE TYPE demi_journee AS ENUM ('matin','apres_midi');
  END IF;
END $$;

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
CREATE TABLE IF NOT EXISTS entreprise (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom VARCHAR(255) NOT NULL,
  politique_conges JSONB NOT NULL DEFAULT '{}',
  parametres JSONB NOT NULL DEFAULT '{}',
  statut entreprise_statut NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_entreprise_updated_at ON entreprise;
CREATE TRIGGER trg_entreprise_updated_at
BEFORE UPDATE ON entreprise
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

---

/* ============================================================
   TABLE utilisateur
============================================================ */
CREATE TABLE IF NOT EXISTS utilisateur (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id UUID NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  prenom VARCHAR(255),
  nom VARCHAR(255) NOT NULL,
  service VARCHAR(255),
  email VARCHAR(255) NOT NULL,
  role utilisateur_role NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  statut utilisateur_statut NOT NULL DEFAULT 'en_attente',
  date_embauche DATE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (entreprise_id, email),
  UNIQUE (id, entreprise_id)
);

CREATE INDEX IF NOT EXISTS idx_utilisateur_entreprise ON utilisateur(entreprise_id);
CREATE INDEX IF NOT EXISTS idx_utilisateur_role ON utilisateur(entreprise_id, role);

DROP TRIGGER IF EXISTS trg_utilisateur_updated_at ON utilisateur;
CREATE TRIGGER trg_utilisateur_updated_at
BEFORE UPDATE ON utilisateur
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

---

/* ============================================================
   TABLE conge_type
============================================================ */
CREATE TABLE IF NOT EXISTS conge_type (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id UUID NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  code VARCHAR(20) NOT NULL,
  libelle VARCHAR(255) NOT NULL,
  quota_annuel NUMERIC(5,2),
  demi_journee_autorisee BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (entreprise_id, code),
  UNIQUE (id, entreprise_id)
);

CREATE INDEX IF NOT EXISTS idx_conge_type_entreprise ON conge_type(entreprise_id);

DROP TRIGGER IF EXISTS trg_conge_type_updated_at ON conge_type;
CREATE TRIGGER trg_conge_type_updated_at
BEFORE UPDATE ON conge_type
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

---

/* ============================================================
   TABLE compteur_conges
============================================================ */
CREATE TABLE IF NOT EXISTS compteur_conges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id UUID NOT NULL,
  utilisateur_id UUID NOT NULL,
  conge_type_id UUID NOT NULL,
  annee INTEGER NOT NULL CHECK (annee >= 2000),
  jours_acquis NUMERIC(5,2) NOT NULL DEFAULT 0,
  jours_pris NUMERIC(5,2) NOT NULL DEFAULT 0,
  jours_reportes NUMERIC(5,2) NOT NULL DEFAULT 0,
  jours_reserves NUMERIC(5,2) NOT NULL DEFAULT 0,
  dernier_credit_mensuel VARCHAR(7),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_compteur UNIQUE (entreprise_id, utilisateur_id, conge_type_id, annee),
  CONSTRAINT fk_compteur_user FOREIGN KEY (utilisateur_id, entreprise_id) REFERENCES utilisateur(id, entreprise_id) ON DELETE CASCADE,
  CONSTRAINT fk_compteur_type FOREIGN KEY (conge_type_id, entreprise_id) REFERENCES conge_type(id, entreprise_id) ON DELETE CASCADE,
  CONSTRAINT check_jours_pris_non_negatif CHECK (jours_pris >= 0),
  CONSTRAINT check_jours_reportes_non_negatif CHECK (jours_reportes >= 0),
  CONSTRAINT check_jours_reserves_non_negatif CHECK (jours_reserves >= 0)
);

CREATE INDEX IF NOT EXISTS idx_compteur_user_annee ON compteur_conges (entreprise_id, utilisateur_id, annee);
CREATE INDEX IF NOT EXISTS idx_compteur_entreprise_annee ON compteur_conges (entreprise_id, annee);
CREATE INDEX IF NOT EXISTS idx_compteur_type ON compteur_conges (entreprise_id, conge_type_id);

DROP TRIGGER IF EXISTS trg_compteur_updated_at ON compteur_conges;
CREATE TRIGGER trg_compteur_updated_at
BEFORE UPDATE ON compteur_conges
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

---

/* ============================================================
   TABLE conge
============================================================ */
CREATE TABLE IF NOT EXISTS conge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id UUID NOT NULL,
  utilisateur_id UUID NOT NULL,
  conge_type_id UUID NOT NULL,
  date_debut DATE NOT NULL,
  date_fin DATE NOT NULL,
  debut_demi_journee demi_journee NOT NULL DEFAULT 'matin',
  fin_demi_journee demi_journee NOT NULL DEFAULT 'apres_midi',
  statut conge_statut NOT NULL DEFAULT 'en_attente_manager',
  commentaire_employe TEXT,
  commentaire_manager TEXT,
  commentaire_admin TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CHECK (date_fin >= date_debut),
  CHECK (
    NOT (
      date_debut = date_fin
      AND debut_demi_journee = 'apres_midi'
      AND fin_demi_journee = 'matin'
    )
  ),
  CONSTRAINT fk_conge_user FOREIGN KEY (utilisateur_id, entreprise_id) REFERENCES utilisateur(id, entreprise_id) ON DELETE CASCADE,
  CONSTRAINT fk_conge_type FOREIGN KEY (conge_type_id, entreprise_id) REFERENCES conge_type(id, entreprise_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conge_user ON conge(entreprise_id, utilisateur_id);
CREATE INDEX IF NOT EXISTS idx_conge_statut ON conge(entreprise_id, statut);
CREATE INDEX IF NOT EXISTS idx_conge_type ON conge(entreprise_id, conge_type_id);
CREATE INDEX IF NOT EXISTS idx_conge_overlap_fast ON conge (entreprise_id, utilisateur_id, date_debut, date_fin);

DROP TRIGGER IF EXISTS trg_conge_updated_at ON conge;
CREATE TRIGGER trg_conge_updated_at
BEFORE UPDATE ON conge
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

---

/* ============================================================
   TRIGGER ANTI-CHEVAUCHEMENT
============================================================ */
DROP TRIGGER IF EXISTS trg_conge_overlap ON conge;
CREATE OR REPLACE FUNCTION check_conge_overlap()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM conge c
    WHERE c.entreprise_id = NEW.entreprise_id
      AND c.utilisateur_id = NEW.utilisateur_id
      AND c.id <> COALESCE(NEW.id, gen_random_uuid())
      AND c.statut IN ('en_attente_manager','valide_manager','valide_final')
      AND c.date_debut <= NEW.date_fin
      AND c.date_fin >= NEW.date_debut
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
   FONCTION CALCUL JOURS OUVRÉS
============================================================ */
CREATE OR REPLACE FUNCTION calcul_jours_ouvres(
    start_date DATE,
    end_date DATE,
    entreprise UUID,
    debut_demi demi_journee,
    fin_demi demi_journee
) RETURNS NUMERIC AS $$
DECLARE
    total_days NUMERIC := 0;
    current_date DATE;
BEGIN
    FOR current_date IN SELECT generate_series(start_date, end_date, interval '1 day')::date LOOP
        IF EXTRACT(DOW FROM current_date) NOT IN (0,6) THEN
            IF NOT EXISTS (
                SELECT 1 FROM jours_feries jf
                WHERE jf.entreprise_id = entreprise
                  AND jf.date = current_date
            ) THEN
                total_days := total_days + 1;
            END IF;
        END IF;
    END LOOP;

    IF start_date = end_date THEN
        IF debut_demi = 'apres_midi' AND fin_demi = 'matin' THEN
            total_days := 0;
        ELSIF debut_demi = 'apres_midi' OR fin_demi = 'matin' THEN
            total_days := total_days - 0.5;
        END IF;
    ELSE
        IF debut_demi = 'apres_midi' THEN total_days := total_days - 0.5; END IF;
        IF fin_demi = 'matin' THEN total_days := total_days - 0.5; END IF;
    END IF;

    RETURN total_days;
END;
$$ LANGUAGE plpgsql;

---

/* ============================================================
   TRIGGER MISE À JOUR COMPTEUR (JOURS OUVRÉS)
============================================================ */
DROP TRIGGER IF EXISTS trg_update_compteur ON conge;
CREATE OR REPLACE FUNCTION update_compteur_on_conge()
RETURNS TRIGGER AS $$
DECLARE
    old_jours NUMERIC(5,2) := 0;
    new_jours NUMERIC(5,2) := 0;
BEGIN
    IF OLD.statut = 'valide_final' THEN
        old_jours := calcul_jours_ouvres(OLD.date_debut, OLD.date_fin, OLD.entreprise_id, OLD.debut_demi_journee, OLD.fin_demi_journee);
    END IF;

    IF NEW.statut = 'valide_final' THEN
        new_jours := calcul_jours_ouvres(NEW.date_debut, NEW.date_fin, NEW.entreprise_id, NEW.debut_demi_journee, NEW.fin_demi_journee);
    END IF;

    IF old_jours > 0 THEN
        UPDATE compteur_conges
        SET jours_pris = GREATEST(jours_pris - old_jours,0), updated_at = NOW()
        WHERE entreprise_id = OLD.entreprise_id
          AND utilisateur_id = OLD.utilisateur_id
          AND conge_type_id = OLD.conge_type_id
          AND annee = EXTRACT(YEAR FROM OLD.date_debut);
    END IF;

    IF new_jours > 0 THEN
        INSERT INTO compteur_conges (
            entreprise_id,
            utilisateur_id,
            conge_type_id,
            annee,
            jours_pris
        )
        VALUES (
            NEW.entreprise_id,
            NEW.utilisateur_id,
            NEW.conge_type_id,
            EXTRACT(YEAR FROM NEW.date_debut),
            new_jours
        )
        ON CONFLICT (entreprise_id, utilisateur_id, conge_type_id, annee)
        DO UPDATE SET
            jours_pris = compteur_conges.jours_pris + EXCLUDED.jours_pris,
            updated_at = NOW();
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_compteur
AFTER INSERT OR UPDATE ON conge
FOR EACH ROW EXECUTE FUNCTION update_compteur_on_conge();

---

/* ============================================================
   TABLE jours_feries
============================================================ */
CREATE TABLE IF NOT EXISTS jours_feries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id UUID NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  libelle VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (entreprise_id, date)
);

DROP TRIGGER IF EXISTS trg_jours_feries_updated_at ON jours_feries;
CREATE TRIGGER trg_jours_feries_updated_at
BEFORE UPDATE ON jours_feries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

---

/* ============================================================
   TABLE audit_log
============================================================ */
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entreprise_id UUID NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  utilisateur_id UUID REFERENCES utilisateur(id) ON DELETE SET NULL,
  action VARCHAR(255) NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}',
  entity_type VARCHAR(50),
  entity_id UUID,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

---

/* ============================================================
   TABLE notification
============================================================ */
CREATE TABLE IF NOT EXISTS notification (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utilisateur_id UUID NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  entreprise_id UUID NOT NULL REFERENCES entreprise(id) ON DELETE CASCADE,
  type VARCHAR(50),
  message TEXT NOT NULL,
  url VARCHAR(255),
  lu BOOLEAN NOT NULL DEFAULT FALSE,
  lu_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

---

/* ============================================================
   VUE CALENDRIER
============================================================ */
CREATE OR REPLACE VIEW v_conge_calendrier AS
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


/* ============================================================
   VUE CALENDRIER CONGÉS
============================================================ */
CREATE OR REPLACE VIEW vue_calendrier_conges AS
SELECT 
    c.id AS conge_id,
    u.id AS utilisateur_id,
    u.nom AS utilisateur_nom,
    u.email AS utilisateur_email,
    ct.id AS conge_type_id,
    ct.libelle AS conge_type,
    c.date_debut,
    c.date_fin,
    c.debut_demi_journee,
    c.fin_demi_journee,
    c.statut
FROM conge c
JOIN utilisateur u ON c.utilisateur_id = u.id
JOIN conge_type ct ON c.conge_type_id = ct.id;