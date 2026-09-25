// Dynamic Expo config: app.json is the single source of truth for the static
// config. The ONLY dynamic override is `experiments.baseUrl`, which is set to
// '/clear-to-close' exclusively for GitHub Pages web deploys (WEB_DEPLOY=1).
//
// Why: app.json must NOT carry experiments.baseUrl unconditionally, because
// the iOS Xcode archive then collides <Name>.app/<Name> (the executable,
// from expo.name) with <Name>.app/<name>/ (the baseUrl asset folder) on
// case-insensitive macOS filesystems -> ENOTDIR -> exit 65 during "Bundle
// React Native code and images" (upstream expo/expo#40862). EAS builds and
// local dev/iOS exports never set WEB_DEPLOY, so they resolve with no baseUrl.
const appJson = require('./app.json');

module.exports = function () {
  const expo = { ...appJson.expo };
  if (process.env.WEB_DEPLOY === '1') {
    expo.experiments = { ...(expo.experiments || {}), baseUrl: '/clear-to-close' };
  }
  return { expo };
};
