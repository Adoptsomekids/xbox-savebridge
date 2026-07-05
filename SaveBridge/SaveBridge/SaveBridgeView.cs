using System;
using Windows.ApplicationModel.Core;
using Windows.UI.Core;

namespace SaveBridge
{
    /// <summary>
    /// IFrameworkViewSource + IFrameworkView — the headless UWP AppContainer entry path.
    /// CoreApplication.Run(new SaveBridgeApp()) in Program.cs launches this chain.
    ///
    /// This is the correct pattern for Xbox sideloaded apps:
    ///   - AppContainer (no runFullTrust / FullTrustApplication)
    ///   - No XAML, no App.xaml
    ///   - HTTP server runs on background thread; Run() drives the CoreWindow message pump
    /// </summary>
    public sealed class SaveBridgeApp : IFrameworkViewSource
    {
        public IFrameworkView CreateView() => new SaveBridgeView();
    }

    public sealed class SaveBridgeView : IFrameworkView
    {
        private SaveBridgeServer? _server;

        public void Initialize(CoreApplicationView applicationView) { }

        public void SetWindow(CoreWindow window) { }

        public void Load(string entryPoint)
        {
            _server = new SaveBridgeServer();
            System.Threading.Tasks.Task.Run(async () =>
            {
                try
                {
                    await _server.StartAsync();
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine("[SaveBridge] Fatal: " + ex.Message);
                }
            });
        }

        public void Run()
        {
            // Drive the message pump so background tasks (HTTP server) keep running.
            CoreWindow.GetForCurrentThread().Dispatcher.ProcessEvents(
                CoreProcessEventsOption.ProcessUntilQuit);
        }

        public void Uninitialize()
        {
            _server?.Stop();
        }
    }
}
