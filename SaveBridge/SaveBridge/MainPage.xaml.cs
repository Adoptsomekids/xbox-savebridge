using System;
using Windows.ApplicationModel.Core;
using Windows.UI.Core;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;

namespace SaveBridge
{
    /// <summary>
    /// Minimal Xbox UWP App — starts the SaveBridgeServer on launch.
    /// Shows a simple status UI on the Xbox screen.
    /// </summary>
    public sealed partial class MainPage : Page
    {
        private SaveBridgeServer _server;

        public MainPage()
        {
            this.InitializeComponent();
            StartServer();
        }

        private async void StartServer()
        {
            try
            {
                UpdateStatus("Starting SaveBridge...");

                _server = new SaveBridgeServer();

                // Show IP address so user knows where to connect from Mac
                var hostNames = Windows.Networking.Connectivity.NetworkInformation
                    .GetHostNames();
                string ip = "unknown";
                foreach (var host in hostNames)
                {
                    if (host.Type == Windows.Networking.HostNameType.Ipv4)
                    {
                        ip = host.CanonicalName;
                        break;
                    }
                }

                UpdateStatus(
                    $"SaveBridge running!\n\n" +
                    $"From your Mac, run:\n" +
                    $"  npm run sync -- --download --xbox-ip {ip} --bridge-port 8765\n\n" +
                    $"Or open in browser:\n" +
                    $"  http://{ip}:8765/status\n\n" +
                    $"Dead Island DE SCID: db860100-d780-4e17-8685-ad130052ea64"
                );

                // Start the HTTP server (blocks in a background task)
                await System.Threading.Tasks.Task.Run(() => _server.StartAsync());
            }
            catch (Exception ex)
            {
                UpdateStatus($"Error: {ex.Message}\n\nMake sure Dead Island DE is installed and you are signed in to Xbox Live.");
            }
        }

        private void UpdateStatus(string message)
        {
            // Marshal to UI thread
            _ = Dispatcher.RunAsync(CoreDispatcherPriority.Normal, () =>
            {
                if (StatusText != null)
                    StatusText.Text = message;
            });
        }
    }
}
