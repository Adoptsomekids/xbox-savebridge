using Windows.ApplicationModel.Activation;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;

namespace SaveBridge
{
    sealed partial class App : Application
    {
        public App() { this.InitializeComponent(); }

        protected override void OnLaunched(LaunchActivatedEventArgs e)
        {
            var rootFrame = Window.Current.Content as Frame;
            if (rootFrame == null)
            {
                rootFrame = new Frame();
                Window.Current.Content = rootFrame;
            }
            if (!rootFrame.Navigate(typeof(MainPage), e.Arguments))
                throw new System.Exception("Failed to create initial page");
            Window.Current.Activate();
        }
    }
}
