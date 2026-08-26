'use strict';
/**
 * emailHtmlInjection.test.js — Fix #27
 *
 * Vérifie que les variables utilisateur interpolées dans les templates email
 * sont correctement échappées pour prévenir l'injection HTML/JS (phishing).
 *
 * Test direct sur emailService.buildHtml() — pas d'envoi réseau.
 */

const emailService = require('../src/services/emailService');

const XSS_COMMENT   = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
const XSS_NAME      = '<b onclick="steal()">Alice</b>';
const EXPECTED_COMMENT_ESCAPED = '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;';
const EXPECTED_NAME_ESCAPED    = '&lt;b onclick=&quot;steal()&quot;&gt;Alice&lt;/b&gt;';

// ---------------------------------------------------------------------------
describe('Fix #27 — Échappement HTML dans les templates email', () => {
  // ---- leave-rejected-employee ----
  describe('leave-rejected-employee : {{commentaire}} échappé', () => {
    let html;

    beforeAll(async () => {
      html = await emailService.buildHtml('leave-rejected-employee', {
        destinataire_prenom: 'Jean',
        date_debut: '2026-08-01',
        date_fin:   '2026-08-10',
        commentaire: XSS_COMMENT,
        action_url:  'https://app.teamoff.fr/conges/123',
      });
    });

    it('ne contient pas la balise <script> brute', () => {
      expect(html).not.toContain('<script>alert("xss")</script>');
    });

    it('contient le commentaire correctement échappé', () => {
      expect(html).toContain(EXPECTED_COMMENT_ESCAPED);
    });
  });

  // ---- leave-new-request-manager : commentaire_employe ----
  describe('leave-new-request-manager : {{commentaire_employe}} échappé', () => {
    let html;

    beforeAll(async () => {
      html = await emailService.buildHtml('leave-new-request-manager', {
        destinataire_prenom: 'Manager',
        demandeur_nom: XSS_NAME,
        date_debut: '2026-08-01',
        date_fin:   '2026-08-10',
        type_conge: 'Congés payés',
        commentaire_employe: XSS_COMMENT,
        jours_attente: '3',
        action_url: 'https://app.teamoff.fr/conges/123',
        overlap_warning_html: '', // champ HTML légitime — vide ici
      });
    });

    it('ne contient pas la balise <script> brute dans commentaire_employe', () => {
      expect(html).not.toContain('<script>alert("xss")</script>');
    });

    it('contient commentaire_employe correctement échappé', () => {
      expect(html).toContain(EXPECTED_COMMENT_ESCAPED);
    });

    it('le nom du demandeur (potentiellement injection) est échappé', () => {
      expect(html).not.toContain('<b onclick=');
      expect(html).toContain(EXPECTED_NAME_ESCAPED);
    });
  });

  // ---- Champs HTML légitimes préservés (non échappés) ----
  describe('Variables HTML légitimes préservées intactes', () => {
    it('overlap_warning_html est inséré tel quel (HTML server-side)', async () => {
      const safeHtml = '<div style="color:red"><strong>Alerte</strong></div>';
      const html = await emailService.buildHtml('leave-new-request-manager', {
        destinataire_prenom: 'Manager',
        demandeur_nom: 'Alice',
        date_debut: '2026-08-01',
        date_fin:   '2026-08-10',
        type_conge: 'CP',
        commentaire_employe: 'Vacances',
        jours_attente: '3',
        action_url: 'https://app.teamoff.fr/conges/123',
        overlap_warning_html: safeHtml,
      });
      expect(html).toContain(safeHtml);
    });
  });
});
