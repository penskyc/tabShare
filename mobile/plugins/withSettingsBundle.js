// Adds Settings.bundle (Settings app -> tabShare -> Server) to the generated iOS project. The app reads the same
// UserDefaults key ("serverUrl") through modules/tabshare-audio.
const { withDangerousMod, withXcodeProject, IOSConfig } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

module.exports = (config) => {
  config = withDangerousMod(config, [
    'ios',
    (c) => {
      const dest = path.join(c.modRequest.platformProjectRoot, c.modRequest.projectName, 'Settings.bundle');
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(path.join(__dirname, 'Settings.bundle', 'Root.plist'), path.join(dest, 'Root.plist'));
      return c;
    },
  ]);
  return withXcodeProject(config, (c) => {
    const name = c.modRequest.projectName;
    const file = `${name}/Settings.bundle`;
    if (!c.modResults.hasFile(file))
      IOSConfig.XcodeUtils.addResourceFileToGroup({ filepath: file, groupName: name, project: c.modResults, isBuildFile: true });
    return c;
  });
};
