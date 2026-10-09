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
const { prepareEmailNotificationMode } = require('../src/utils/emailNotificationMode');
const fs = require('fs');
const path = require('path');

const XSS_COMMENT   = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
const XSS_NAME      = '<b onclick="steal()">Alice</b>';
const EXPECTED_COMMENT_ESCAPED = '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;';
const EXPECTED_NAME_ESCAPED    = '&lt;b onclick=&quot;steal()&quot;&gt;Alice&lt;/b&gt;';

const templatesDir = path.join(__dirname, '../src/templates/emails');
const templates = fs.readdirSync(templatesDir).filter(name => name.endsWith('.html'));
const htmlFields = new Set([
  'content', 'table_rows', 'comments_rows', 'decompte_rows', 'employe_context',
  'bouton_action', 'service_summary_rows', 'nouvelle_periode_row', 'detail_rows',
  'entreprise_footer',
]);

test.each(templates)('%s préserve les fragments HTML et échappe les données textuelles', async (filename) => {
  const source = fs.readFileSync(path.join(templatesDir, filename), 'utf8');
  const keys = [...new Set([...source.matchAll(/{{(\w+)}}/g)].map(match => match[1]))];
  const fragment = '<span>Fragment serveur</span>';
  const data = {};
  for (const key of keys) {
    data[key] = htmlFields.has(key) || key.endsWith('_html') ? fragment : XSS_NAME;
  }
  delete data.entreprise_footer;
  delete data.year;
  delete data.app_name;
  const html = await emailService.buildHtml(filename.replace(/\.html$/, ''), data);
  expect(html).not.toContain('&lt;span&gt;Fragment serveur');
  expect(html).not.toContain('<b onclick=');
  expect(html).not.toMatch(/{{\w+}}/);
  if (keys.some(key => htmlFields.has(key) && key !== 'entreprise_footer' || key.endsWith('_html'))) {
    expect(html).toContain(fragment);
  }
});

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
    it.each(['leave-pending-reminder', 'leave-reservation-reminder'])(
      '%s affiche le bouton de traitement sans balises échappées',
      async (templateName) => {
        const { data } = prepareEmailNotificationMode('Rappel', templateName, {
          notification_mode: 'action',
          destinataire_prenom: XSS_NAME,
          action_url: 'https://app.teamoff.fr/conges/123',
        });
        const html = await emailService.buildHtml(templateName, data);
        expect(html).toContain(data.bouton_action);
        expect(html).not.toContain('&lt;p&gt;&lt;a');
        expect(html).toContain(EXPECTED_NAME_ESCAPED);
      }
    );

    it('un rappel informatif ne contient pas de bouton de traitement', async () => {
      const { data } = prepareEmailNotificationMode('Rappel', 'leave-pending-reminder', {
        notification_mode: 'information',
        action_url: 'https://app.teamoff.fr/conges/123',
      });
      const html = await emailService.buildHtml('leave-pending-reminder', data);
      expect(html).not.toContain('Traiter la demande');
      expect(html).not.toContain('{{bouton_action}}');
    });

    it('le bouton de demande admin est rendu en HTML', async () => {
      const bouton = '<p><a href="https://app.teamoff.fr/conges">Traiter la demande</a></p>';
      const html = await emailService.buildHtml('leave-action-request-admin', {
        bouton_action: bouton,
      });
      expect(html).toContain(bouton);
      expect(html).not.toContain('&lt;p&gt;&lt;a');
    });

    it('le récapitulatif par service est rendu comme un tableau', async () => {
      const rows = '<tr><td>Finance</td><td>1</td><td>0</td></tr>';
      const html = await emailService.buildHtml('weekly-manager-summary', {
        service_summary_rows: rows,
      });
      expect(html).toContain(`<tbody>${rows}</tbody>`);
      expect(html).not.toContain('&lt;tr&gt;');
    });

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
