using Windows.ApplicationModel.Core;

namespace SaveBridge
{
    /// <summary>
    /// Entry point for the headless UWP app.
    /// CoreApplication.Run() is the only XAML-free way to start a UWP process.
    /// No App.xaml, no XAML compiler, no WMC type-universe pass needed.
    /// </summary>
    static class Program
    {
        static void Main(string[] args)
        {
            CoreApplication.Run(new SaveBridgeViewSource());
        }
    }
}
