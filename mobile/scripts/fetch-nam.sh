#!/bin/sh
# Fetches NeuralAmpModelerCore (MIT) and Eigen (MPL-2.0) for the native rig into modules/tabshare-audio/ios/vendor
# (gitignored). Runs on `npm install`; pinned, and skipped when already there.
set -e
DIR="$(dirname "$0")/../modules/tabshare-audio/ios/vendor/namcore"
TAG=v0.6.0
[ -f "$DIR/.tag" ] && [ "$(cat "$DIR/.tag")" = "$TAG" ] && exit 0
rm -rf "$DIR"
git clone -q --depth 1 --branch "$TAG" https://github.com/sdatkinson/NeuralAmpModelerCore "$DIR"
git -C "$DIR" -c advice.detachedHead=false submodule update -q --init --depth 1 Dependencies/eigen
echo "$TAG" > "$DIR/.tag"
