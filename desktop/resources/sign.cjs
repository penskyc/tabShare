// electron-builder `mac.sign`: the default signing, except tabshare_plugin_host gets entitlements.host.plist. electron-builder
// itself only tells the app apart from "everything else", and only the plugin host should run with library validation off.
const path = require('node:path');

module.exports = async (opts) => {
  const { signAsync } = await import('@electron/osx-sign');
  const forFile = opts.optionsForFile;
  return signAsync({
    ...opts,
    optionsForFile: (file) => ({
      ...forFile(file),
      ...(path.basename(file) === 'tabshare_plugin_host' && { entitlements: path.join(__dirname, 'entitlements.host.plist') }),
    }),
  });
};
