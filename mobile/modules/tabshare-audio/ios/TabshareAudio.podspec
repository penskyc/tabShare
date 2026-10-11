Pod::Spec.new do |s|
  s.name           = 'TabshareAudio'
  s.version        = '1.0.0'
  s.summary        = 'Low-latency instrument rig (Core Audio + NAM) for tabShare'
  s.description    = 'Interface input -> NAM amp model -> cab IR -> monitor, streamed into the tabShare call.'
  s.author         = 'Corey Pensky'
  s.homepage       = 'https://github.com/penskyc/tabShare'
  s.license        = 'AGPL-3.0'
  s.platforms      = { :ios => '17.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  nam = 'vendor/namcore' # scripts/fetch-nam.sh
  s.source_files = ['TabshareAudioModule.swift', 'TabshareEngine.{h,mm}', "#{nam}/NAM/**/*.cpp"]
  s.public_header_files = 'TabshareEngine.h' # Swift sees only this; the NAM/Eigen C++ headers stay private
  s.preserve_paths = "#{nam}/**/*"
  s.frameworks = 'AVFoundation', 'AudioToolbox'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
    'HEADER_SEARCH_PATHS' => "\"$(PODS_TARGET_SRCROOT)/#{nam}\" \"$(PODS_TARGET_SRCROOT)/#{nam}/Dependencies\" \"$(PODS_TARGET_SRCROOT)/#{nam}/Dependencies/nlohmann\" \"$(PODS_TARGET_SRCROOT)/#{nam}/Dependencies/eigen\"",
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) NAM_SAMPLE_FLOAT=1 NAM_ENABLE_A2_FAST=1',
    # The amp model must run at full speed even in debug builds, or the audio thread misses its deadline.
    'GCC_OPTIMIZATION_LEVEL' => '3',
    'GCC_WARN_INHIBIT_ALL_WARNINGS' => 'YES',
  }
end
