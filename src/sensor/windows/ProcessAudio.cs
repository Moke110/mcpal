using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;

// WASAPI process loopback (Windows build 20348+). The activation blob selects
// the target process tree, including renderers of multi-process meeting apps.
[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IActivation {
    void GetActivateResult(out int result, [MarshalAs(UnmanagedType.IUnknown)] out object client);
}
[Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ICompletion { void ActivateCompleted(IActivation operation); }

[Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAgileObject {}

[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public class Completion : ICompletion, IAgileObject {
    public AutoResetEvent Done = new AutoResetEvent(false);
    public object Client;
    public int Result;
    public void ActivateCompleted(IActivation operation) {
        try { operation.GetActivateResult(out Result, out Client); }
        catch (Exception e) { Result = e.HResult; }
        finally { Done.Set(); }
    }
}

[StructLayout(LayoutKind.Sequential, Pack=2)]
public struct WaveFormat {
    public ushort Format, Channels;
    public uint Rate, BytesPerSecond;
    public ushort Align, Bits, Extra;
}
[StructLayout(LayoutKind.Explicit, Size=24)]
public struct BlobVariant {
    [FieldOffset(0)] public ushort Type;
    [FieldOffset(8)] public uint Size;
    [FieldOffset(16)] public IntPtr Data;
}

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioClient {
    void Initialize(int share, uint flags, long duration, long period, ref WaveFormat format, IntPtr session);
    void GetBufferSize(out uint frames);
    void GetStreamLatency(out long latency);
    void GetCurrentPadding(out uint padding);
    void IsFormatSupported();
    void GetMixFormat();
    void GetDevicePeriod();
    void Start();
    void Stop();
    void Reset();
    void SetEventHandle(IntPtr handle);
    void GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}
[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ICapture {
    void GetBuffer(out IntPtr data, out uint frames, out uint flags, IntPtr device, IntPtr counter);
    void ReleaseBuffer(uint frames);
    void GetNextPacketSize(out uint frames);
}

public class ProcessAudio {
    [DllImport("Mmdevapi.dll", CharSet=CharSet.Unicode, ExactSpelling=true, PreserveSig=false)]
    static extern void ActivateAudioInterfaceAsync(string device, ref Guid iid, ref BlobVariant variant,
        ICompletion callback, out IActivation operation);

    static volatile bool stopping;
    static string Exe(Process process) {
        try { return process.MainModule.FileName; } catch { return null; }
    }

    static IAudioClient Activate(int pid) {
        var callback = new Completion();
        var variant = new BlobVariant { Type=65, Size=12, Data=Marshal.AllocHGlobal(12) };
        try {
            Marshal.Copy(new int[] { 1, pid, 0 }, 0, variant.Data, 3);
            var iid = typeof(IAudioClient).GUID;
            IActivation operation;
            ActivateAudioInterfaceAsync(@"VAD\Process_Loopback", ref iid, ref variant, callback, out operation);
            if (!callback.Done.WaitOne(8000)) throw new TimeoutException();
            Marshal.ThrowExceptionForHR(callback.Result);
            GC.KeepAlive(operation);
            return (IAudioClient)callback.Client;
        } finally { Marshal.FreeHGlobal(variant.Data); }
    }

    static void Drain(ICapture capture, Stream output) {
        uint size;
        while (true) {
            capture.GetNextPacketSize(out size);
            if (size == 0) return;
            IntPtr data;
            uint frames, flags;
            capture.GetBuffer(out data, out frames, out flags, IntPtr.Zero, IntPtr.Zero);
            try {
                byte[] pcm = new byte[frames * 2];
                if ((flags & 2) == 0) Marshal.Copy(data, pcm, 0, pcm.Length);
                output.Write(pcm, 0, pcm.Length);
            } finally { capture.ReleaseBuffer(frames); }
        }
    }

    [MTAThread]
    public static int Main(string[] args) {
        try {
            if (args.Length == 1 && args[0] == "--list") {
                Console.OutputEncoding = new System.Text.UTF8Encoding(false);
                foreach (var process in Process.GetProcesses().Where(p => p.MainWindowHandle != IntPtr.Zero)) {
                    var path = Exe(process);
                    if (path != null) Console.WriteLine(path);
                }
                return 0;
            }
            var target = Process.GetProcessesByName(Path.GetFileNameWithoutExtension(args[0]))
                .Where(p => String.Equals(Exe(p), args[0], StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(p => p.MainWindowHandle != IntPtr.Zero).ThenBy(p => p.StartTime).FirstOrDefault();
            if (target == null) return 2;
            var client = Activate(target.Id);
            var format = new WaveFormat { Format=1, Channels=1, Rate=16000, BytesPerSecond=32000, Align=2, Bits=16 };
            client.Initialize(0, 0x80060000, 0, 0, ref format, IntPtr.Zero);
            var iid = typeof(ICapture).GUID;
            object service;
            client.GetService(ref iid, out service);
            var capture = (ICapture)service;
            using (var signal = new AutoResetEvent(false)) {
                client.SetEventHandle(signal.SafeWaitHandle.DangerousGetHandle());
                client.Start();
                var output = Console.OpenStandardOutput();
                output.WriteByte(1);
                output.Flush();
                var control = new Thread(() => { Console.OpenStandardInput().ReadByte(); stopping = true; });
                control.IsBackground = true;
                control.Start();
                while (!target.HasExited && !stopping) {
                    signal.WaitOne(100);
                    Drain(capture, output);
                }
                client.Stop();
                Drain(capture, output);
                return target.HasExited ? 2 : 0;
            }
        } catch (Exception error) {
            Console.Error.WriteLine(error);
            return 1;
        }
    }
}
