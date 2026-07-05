using System;
using Windows.ApplicationModel.Core;
using Windows.UI.Core;

namespace SaveBridge
{
    /// <summary>
    /// IFrameworkViewSource + IFrameworkView — the XAML-free UWP entry path.
    /// CoreApplication.Run(new SaveBridgeViewSource()) launches this chain.
    /// No App.xaml, no XAML compiler, no WMC type-universe pass.
    /// </summary>
    public sealed class SaveBridgeViewSource : IFrameworkViewSource
    {
        public IFrameworkView CreateView()
        {
            return new SaveBridgeView();
        }
    }

    public sealed class SaveBridgeView : IFrameworkView
    {
        private SaveBridgeServer _server;

        public void Initialize(CoreApplicationView applicationView)
        {
            // no-op — server starts in Load
        }

        public void SetWindow(CoreWindow window)
        {
            // no-op — we run headless
        }

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
            // Keep the message pump alive so background tasks (HTTP server) continue running.
            CoreWindow.GetForCurrentThread().Dispatcher.ProcessEvents(
                CoreProcessEventsOption.ProcessUntilQuit);
        }

        public void Uninitialize()
        {
            if (_server != null)
                _server.Stop();
        }
    }
}
