using System;
using Windows.ApplicationModel.Core;

namespace SaveBridge
{
    /// <summary>
    /// Entry point for the headless UWP AppContainer app.
    ///
    /// CoreApplication.Run(IFrameworkViewSource) is the XAML-free UWP startup path.
    /// EntryPoint in Package.appxmanifest = "SaveBridge.SaveBridgeApp"
    /// No App.xaml, no XAML compiler, no WMC type-universe pass.
    /// </summary>
    static class Program
    {
        static void Main(string[] args)
        {
            CoreApplication.Run(new SaveBridgeApp());
        }
    }
}
