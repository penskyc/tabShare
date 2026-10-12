#!/bin/sh
# Builds a Release archive and uploads it to App Store Connect (TestFlight) with the Apple account signed in to Xcode.
# One-time: create the app in App Store Connect (bundle ID dev.coreypensky.tabshare). Version: app.json `version`;
# the build number is the current time, so every upload is newer than the last.
set -e
cd "$(dirname "$0")/.."
# App Store Connect rejects builds from beta Xcodes ("Unsupported SDK or Xcode version"); use the released one even
# when xcode-select points at Xcode-beta.
if [ -z "$DEVELOPER_DIR" ] && [ -d /Applications/Xcode.app ]; then export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer; fi
echo "Building with $(xcodebuild -version | head -1) ($(xcodebuild -version | tail -1))"
OUT=build/testflight
rm -rf "$OUT" && mkdir -p "$OUT"
npx expo prebuild --platform ios --clean
plutil -replace CFBundleVersion -string "$(date +%Y%m%d%H%M)" ios/tabShare/Info.plist
cat > "$OUT/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>7HBNH5BQ6T</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
PLIST
xcodebuild -workspace ios/tabShare.xcworkspace -scheme tabShare -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$OUT/tabShare.xcarchive" -allowProvisioningUpdates DEVELOPMENT_TEAM=7HBNH5BQ6T CODE_SIGN_STYLE=Automatic archive
xcodebuild -exportArchive -archivePath "$OUT/tabShare.xcarchive" -exportOptionsPlist "$OUT/ExportOptions.plist" \
  -exportPath "$OUT" -allowProvisioningUpdates
echo "Uploaded. It shows up in App Store Connect -> TestFlight after Apple's processing (usually 5-15 minutes)."
