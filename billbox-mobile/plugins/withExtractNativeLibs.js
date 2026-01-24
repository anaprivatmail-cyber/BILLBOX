const { withAndroidManifest } = require("@expo/config-plugins");

module.exports = function withExtractNativeLibs(config) {
  return withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    if (application) {
      if (!application.$) application.$ = {};
      application.$["android:extractNativeLibs"] = "true";
    }
    return config;
  });
};
