/**
 * withAndroidBackupRules — blanket Android backup/transfer exclusion.
 *
 * Security rationale (auditor-approved design, Oct 15 2026): the app
 * holds two kinds of device-bound secrets that must never ride an
 * Android backup or a device-to-device transfer —
 *   - the Supabase session (SecureStore), and
 *   - the client-link device identity (one live link per device: a
 *     restored device id/token pair on a second phone would defeat
 *     the one-device access key).
 * expo-secure-store's own plugin excludes only its own preferences
 * file; AsyncStorage and everything else back up by default. This
 * plugin excludes EVERY domain instead, on both mechanisms:
 *   - Android 12+ (API 31): android:dataExtractionRules ->
 *     res/xml/data_extraction_rules.xml (cloud-backup + device-transfer)
 *   - Legacy (pre-31): android:fullBackupContent ->
 *     res/xml/backup_rules.xml
 * A restored install therefore boots signed-out with no resurrected
 * client link — the approved degraded state.
 *
 * Condition from the approval: the Phase report shows the
 * PREBUILD-GENERATED manifest + XML as generated (not this source) —
 * run `npx expo prebuild` and read android/app/src/main before
 * claiming it. Runtime restore tests (API 31+ and pre-31) need
 * devices and are tracked separately.
 */
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const DOMAINS = [
  'root',
  'file',
  'database',
  'sharedpref',
  'external',
  'device_root',
  'device_file',
  'device_database',
  'device_sharedpref',
];

function excludesXml(indent) {
  return DOMAINS.map((d) => `${indent}<exclude domain="${d}" path="." />`).join('\n');
}

const DATA_EXTRACTION_RULES = `<?xml version="1.0" encoding="utf-8"?>
<!-- Blanket exclusion: nothing backs up, nothing transfers. See
     plugins/withAndroidBackupRules.js for the rationale. -->
<data-extraction-rules>
    <cloud-backup>
${excludesXml('        ')}
    </cloud-backup>
    <device-transfer>
${excludesXml('        ')}
    </device-transfer>
</data-extraction-rules>
`;

const BACKUP_RULES = `<?xml version="1.0" encoding="utf-8"?>
<!-- Blanket exclusion (legacy fullBackupContent, pre-API 31). See
     plugins/withAndroidBackupRules.js for the rationale. -->
<full-backup-content>
${excludesXml('    ')}
</full-backup-content>
`;

function withAndroidBackupRules(config) {
  config = withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application[0];
    app.$['android:fullBackupContent'] = '@xml/backup_rules';
    app.$['android:dataExtractionRules'] = '@xml/data_extraction_rules';
    return cfg;
  });
  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const xmlDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
        'xml',
      );
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, 'data_extraction_rules.xml'), DATA_EXTRACTION_RULES);
      fs.writeFileSync(path.join(xmlDir, 'backup_rules.xml'), BACKUP_RULES);
      return cfg;
    },
  ]);
  return config;
}

module.exports = withAndroidBackupRules;
