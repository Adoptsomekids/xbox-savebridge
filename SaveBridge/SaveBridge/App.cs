using System;
using Windows.ApplicationModel.Core;
using Windows.UI.Core;

namespace SaveBridge
{
    /// <summary>
    /// Entry point for SaveBridge — a headless UWP background service.
    /// No XAML required; CoreApplication.Run drives the message loop.
    /// </summary>
    internal sealed class AppViewSource : IFrameworkViewSource
    {
        public IFrameworkView CreateView() { return new AppView(); }
    }

    internal sealed class AppView : IFrameworkView
    {
        private SaveBridgeServer _server;

        public void Initialize(CoreApplicationView view) { }
        public void SetWindow(CoreWindow window) { }
        public void Load(string entryPoint) { }

        public void Run()
        {
            // Start the HTTP bridge server on a background thread
            _server = new SaveBridgeServer();
            var task = System.Threading.Tasks.Task.Run(() => _server.StartAsync());

            // Pump the CoreWindow message loop so the app stays alive
            CoreWindow.GetForCurrentThread().Activate();
            var dispatcher = CoreWindow.GetForCurrentThread().Dispatcher;
            dispatcher.ProcessEvents(CoreProcessEventsOption.ProcessUntilQuit);
        }

        public void Uninitialize()
        {
            if (_server != null) _server.Stop();
        }
    }

    internal static class Program
    {
        [global::System.MTAThread]
        static void Main(string[] args)
        {
            CoreApplication.Run(new AppViewSource());
        }
    }
}
