// iOS 27 asserts at launch unless the app uses the scene life cycle. Expo SDK 57 ships ExpoAppSceneDelegate for this,
// but its app template still starts React Native from the app delegate; switch the generated project over.
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const START = /\n#if os\(iOS\) \|\| os\(tvOS\)\n {4}window = UIWindow\(frame: UIScreen\.main\.bounds\)\n[\s\S]*?\n#endif\n/;

module.exports = (config) => {
  config = withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          { UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: 'EXExpoAppSceneDelegate' },
        ],
      },
    };
    return c;
  });
  return withAppDelegate(config, (c) => {
    let src = c.modResults.contents;
    if (src.includes('ExpoReactNativeFactoryProvider')) return c;
    const decl = 'class AppDelegate: ExpoAppDelegate {';
    if (!src.includes(decl) || !START.test(src)) throw new Error('withSceneLifecycle: the AppDelegate template changed; update the plugin');
    src = src.replace(decl, 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {');
    src = src.replace(START, '\n    // The window and React Native start in ExpoAppSceneDelegate (scene life cycle).\n');
    c.modResults.contents = src;
    return c;
  });
};
