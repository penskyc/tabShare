# VST3 hosting for the desktop engine (loaded by engine.mjs). Built with cmake-js:
#   npm run build:native   (from desktop/)
# Windows: tabshare_vst.node hosts the plugins in process (JUCE).
# macOS:   tabshare_vst.node is a JUCE-free client; the plugins run in tabshare_plugin_host (see vst.cpp, host.cpp).
cmake_minimum_required(VERSION 3.22)
project(tabshare_vst VERSION 0.1.0 LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

include(FetchContent)
FetchContent_Declare(JUCE GIT_REPOSITORY https://github.com/juce-framework/JUCE.git GIT_TAG 8.0.15 GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(JUCE)

set(JUCE_DEFS
  JUCE_PLUGINHOST_VST3=1 JUCE_PLUGINHOST_VST=0 JUCE_PLUGINHOST_AU=0 JUCE_PLUGINHOST_LADSPA=0 JUCE_PLUGINHOST_LV2=0
  JUCE_STANDALONE_APPLICATION=0 JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0 JUCE_DISPLAY_SPLASH_SCREEN=0
  JUCE_MODAL_LOOPS_PERMITTED=1)
set(JUCE_LIBS juce::juce_audio_processors juce::juce_gui_basics juce::juce_recommended_config_flags)

add_library(tabshare_vst SHARED vst.cpp ${CMAKE_JS_SRC})
set_target_properties(tabshare_vst PROPERTIES PREFIX "" SUFFIX ".node")
execute_process(COMMAND node -p "require('node-addon-api').include" WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}/.. OUTPUT_VARIABLE NODE_ADDON_API_DIR OUTPUT_STRIP_TRAILING_WHITESPACE)
string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
target_include_directories(tabshare_vst PRIVATE ${CMAKE_JS_INC} ${NODE_ADDON_API_DIR})
target_compile_definitions(tabshare_vst PRIVATE NAPI_VERSION=8 NAPI_DISABLE_CPP_EXCEPTIONS)
target_link_libraries(tabshare_vst PRIVATE ${CMAKE_JS_LIB})

if(APPLE)
  add_executable(tabshare_plugin_host host.cpp plugins.cpp)
  target_compile_definitions(tabshare_plugin_host PRIVATE ${JUCE_DEFS})
  target_link_libraries(tabshare_plugin_host PRIVATE ${JUCE_LIBS})
  # Next to the addon, where engine.mjs looks for it.
  set_target_properties(tabshare_plugin_host PROPERTIES RUNTIME_OUTPUT_DIRECTORY $<TARGET_FILE_DIR:tabshare_vst>)
else()
  target_sources(tabshare_vst PRIVATE plugins.cpp)
  target_compile_definitions(tabshare_vst PRIVATE ${JUCE_DEFS})
  target_link_libraries(tabshare_vst PRIVATE ${JUCE_LIBS} avrt)
endif()

if(MSVC AND CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET)
  execute_process(COMMAND ${CMAKE_AR} /def:${CMAKE_JS_NODELIB_DEF} /out:${CMAKE_JS_NODELIB_TARGET} ${CMAKE_STATIC_LINKER_FLAGS})
endif()
