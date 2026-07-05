using System;
using System.Collections.Generic;
using Windows.UI.Core;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;

namespace SaveBridge
{
    public sealed partial class MainPage : Page
    {
        private readonly SaveBridgeServer _server = new SaveBridgeServer();
        private readonly List<string> _logLines = new List<string>();
        private const int MaxLogLines = 500;

        public MainPage()
        {
            this.InitializeComponent();
            _server.LogMessage += OnServerLog;
            AppendLog("SaveBridge ready. Press 'Start Server' to begin.");
            AppendLog("SCID: db860100-d780-4e17-8685-ad130052ea64");
            AppendLog("Port: 8765");
        }

        private void OnServerLog(string message)
        {
            // Marshal back to UI thread
            var _ = Dispatcher.RunAsync(CoreDispatcherPriority.Normal, () => AppendLog(message));
        }

        private void AppendLog(string message)
        {
            string line = DateTime.Now.ToString("HH:mm:ss") + "  " + message;
            _logLines.Add(line);
            if (_logLines.Count > MaxLogLines)
                _logLines.RemoveAt(0);
            LogOutput.Text = string.Join("\n", _logLines);
            LogScrollViewer.ChangeView(0, double.MaxValue, 1f);
        }

        private async void StartButton_Click(object sender, RoutedEventArgs e)
        {
            StartButton.IsEnabled = false;
            StopButton.IsEnabled  = false;
            StatusText.Text       = "Status: Starting…";
            AddressText.Text      = "";

            try
            {
                await _server.StartAsync();
                StatusText.Text  = "Status: Running";
                AddressText.Text = "http://<xbox-ip>:8765/status  |  /save/list  |  /save/download  |  /save/upload";
                StopButton.IsEnabled = true;
            }
            catch (Exception ex)
            {
                StatusText.Text = "Status: Error — " + ex.Message;
                StartButton.IsEnabled = true;
            }
        }

        private void StopButton_Click(object sender, RoutedEventArgs e)
        {
            _server.Stop();
            StatusText.Text  = "Status: Stopped";
            AddressText.Text = "";
            StartButton.IsEnabled = true;
            StopButton.IsEnabled  = false;
        }
    }
}
