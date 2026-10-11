import ExpoModulesCore

/// JS side of the native rig: `send` passes page -> engine messages (JSON), `onMessage` carries engine -> page messages.
/// Also keeps the server URL (UserDefaults, so the iOS Settings app can change it too).
public class TabshareAudioModule: Module {
  private var engine: TabshareEngine?

  public func definition() -> ModuleDefinition {
    Name("TabshareAudio")
    Events("onMessage")

    OnCreate {
      self.engine = TabshareEngine { [weak self] json in self?.sendEvent("onMessage", ["json": json]) }
    }
    OnDestroy {
      self.engine?.shutdown()
    }

    Function("send") { (json: String) in self.engine?.handle(json) }
    Function("getServerUrl") { UserDefaults.standard.string(forKey: "serverUrl") ?? "" }
    Function("setServerUrl") { (url: String) in UserDefaults.standard.set(url, forKey: "serverUrl") }
  }
}
