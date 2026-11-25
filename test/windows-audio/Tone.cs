using System;
using System.IO;
using System.Media;
using System.Threading;

// Generates a steady, low-volume tone from a separate Windows process.
class Tone {
    static void Main(string[] args) {
        int hz = Int32.Parse(args[0]);
        var data = new MemoryStream();
        var writer = new BinaryWriter(data);
        writer.Write(System.Text.Encoding.ASCII.GetBytes("RIFF")); writer.Write(32036);
        writer.Write(System.Text.Encoding.ASCII.GetBytes("WAVEfmt ")); writer.Write(16);
        writer.Write((short)1); writer.Write((short)1); writer.Write(16000); writer.Write(32000);
        writer.Write((short)2); writer.Write((short)16);
        writer.Write(System.Text.Encoding.ASCII.GetBytes("data")); writer.Write(32000);
        for (int i=0; i<16000; i++) writer.Write((short)(500 * Math.Sin(2*Math.PI*hz*i/16000)));
        data.Position = 0;
        using (var player = new SoundPlayer(data)) {
            player.PlayLooping();
            Thread.Sleep(8500);
        }
    }
}
