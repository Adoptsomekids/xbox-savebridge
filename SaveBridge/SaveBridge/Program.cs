using System;
using System.Threading.Tasks;

namespace SaveBridge
{
    /// <summary>
    /// Entry point for the packaged Win32 sideloaded UWP app.
    ///
    /// EntryPoint in Package.appxmanifest = "Windows.FullTrustApplication"
    /// This means Windows launches SaveBridge.exe directly.
    /// No CoreApplication/IFrameworkView wiring required.
    /// </summary>
    static class Program
    {
        [STAThread]
        static async Task Main(string[] args)
        {
            Console.WriteLine("[SaveBridge] Starting...");

            var server = new SaveBridgeServer();

            // Graceful shutdown on CTRL+C (if ever run from console)
            Console.CancelKeyPress += (_, e) =>
            {
                e.Cancel = true;
                server.Stop();
            };

            try
            {
                await server.StartAsync();
            }
            catch (Exception ex)
            {
                Console.WriteLine("[SaveBridge] Fatal: " + ex);
                Environment.Exit(1);
            }
        }
    }
}
