using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace Rewind.NativeBrowser {
  public static class PrivatePipe {
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
      public uint length; public IntPtr descriptor; public int inherit;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafePipeHandle CreateNamedPipeW(string name, uint openMode, uint mode, uint instances, uint output, uint input, uint timeout, ref SecurityAttributes security);
    public static NamedPipeServerStream FirstServer(string name) { return Create(name,true); }
    internal static NamedPipeServerStream NextServer(string name,NamedPipeServerStream anchor) {
      if(anchor==null || !anchor.IsConnected || anchor.SafePipeHandle.IsClosed) throw new IOException("PIPE_ANCHOR_UNAVAILABLE");
      using(ProcessProof owner=ProcessProof.PipePeer(anchor.SafePipeHandle,true)) {
        if(owner.id!=(uint)Process.GetCurrentProcess().Id) throw new IOException("PIPE_ANCHOR_INVALID");
        return Create(name,false);
      }
    }
    static NamedPipeServerStream Create(string name,bool first) {
      if(name==null || !Regex.IsMatch(name,"^rewind[.][a-z0-9.]{1,120}$")) throw new IOException("PIPE_NAME_POLICY");
      using(WindowsIdentity user=WindowsIdentity.GetCurrent()) {
        if(user.User==null) throw new IOException("PIPE_USER_UNAVAILABLE");
        PipeSecurity security=new PipeSecurity();security.SetAccessRuleProtection(true,false);
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid,null),PipeAccessRights.FullControl,AccessControlType.Deny));
        security.AddAccessRule(new PipeAccessRule(user.User,PipeAccessRights.FullControl,AccessControlType.Allow));
        byte[] descriptor=security.GetSecurityDescriptorBinaryForm();
        IntPtr pointer=Marshal.AllocHGlobal(descriptor.Length);
        SafePipeHandle handle=null;
        try {
          Marshal.Copy(descriptor,0,pointer,descriptor.Length);
          SecurityAttributes attributes=new SecurityAttributes {length=(uint)Marshal.SizeOf(typeof(SecurityAttributes)),descriptor=pointer,inherit=0};
          // Duplex, overlapped, FIRST_PIPE_INSTANCE; byte mode and REJECT_REMOTE_CLIENTS.
          handle=CreateNamedPipeW(@"\\.\pipe\"+name,0x40000003u|(first ? 0x80000u : 0u),8,5,65536,65536,1000,ref attributes);
          if(handle.IsInvalid) throw new IOException("PRIVATE_PIPE_UNAVAILABLE");
          NamedPipeServerStream stream=new NamedPipeServerStream(PipeDirection.InOut,true,false,handle);
          handle=null;return stream;
        } finally {
          if(handle!=null) handle.Dispose();
          Marshal.FreeHGlobal(pointer);
        }
      }
    }
  }
  // Native host/broker foundation. Querying these facts does not grant recording consent.
  public sealed class ProcessProof : IDisposable {
    sealed class ProcessHandle : SafeHandleZeroOrMinusOneIsInvalid {
      public ProcessHandle() : base(true) {}
      protected override bool ReleaseHandle() { return CloseHandle(handle); }
    }
    [StructLayout(LayoutKind.Sequential)] struct BasicInfo {
      public IntPtr reserved, peb, reserved2, reserved3, processId, parentId;
    }
    [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint low, high; }
    [DllImport("kernel32.dll", SetLastError=true)] static extern ProcessHandle OpenProcess(uint access, bool inherit, uint id);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageNameW(ProcessHandle handle, uint flags, StringBuilder value, ref uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(ProcessHandle handle, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ProcessIdToSessionId(uint id, out uint session);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(ProcessHandle handle, uint milliseconds);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(ProcessHandle process, uint access, out IntPtr token);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(ProcessHandle handle, int kind, out BasicInfo value, uint size, out uint written);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint id);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint id);
    readonly ProcessHandle handle;
    public readonly uint id, parentId, sessionId;
    public readonly string path, userSid;
    public readonly long created;
    bool disposed;
    ProcessProof(ProcessHandle value, uint pid, uint parent, uint session, string executable, string sid, long started) {
      handle=value;id=pid;parentId=parent;sessionId=session;path=executable;userSid=sid;created=started;
    }
    public bool Alive() {
      // A process may legally exit with STILL_ACTIVE (259); test its kernel object instead.
      return !disposed && WaitForSingleObject(handle,0)==258;
    }
    public void Dispose() { if(!disposed) {disposed=true;handle.Dispose();} }
    public static ProcessProof Query(uint id) {
      if(id==0) throw new IOException("PEER_PROCESS_INVALID");
      ProcessHandle handle=OpenProcess(0x101000,false,id);
      try {
        if(handle.IsInvalid) throw new IOException("PEER_PROCESS_UNAVAILABLE");
        StringBuilder name=new StringBuilder(32768);uint size=32768;
        if(!QueryFullProcessImageNameW(handle,0,name,ref size) || size==0 || size>=32768) throw new IOException("PEER_IMAGE_UNAVAILABLE");
        FileTime created,exited,kernel,user;
        if(!GetProcessTimes(handle,out created,out exited,out kernel,out user)) throw new IOException("PEER_TIME_UNAVAILABLE");
        BasicInfo info;uint written;
        if(NtQueryInformationProcess(handle,0,out info,(uint)Marshal.SizeOf(typeof(BasicInfo)),out written)!=0 || written!=(uint)Marshal.SizeOf(typeof(BasicInfo)) || info.processId.ToInt64()!=id || info.parentId.ToInt64()<0 || info.parentId.ToInt64()>UInt32.MaxValue) throw new IOException("PEER_PARENT_UNAVAILABLE");
        IntPtr token;
        if(!OpenProcessToken(handle,8,out token)) throw new IOException("PEER_USER_UNAVAILABLE");
        string sid;
        try {using(WindowsIdentity identity=new WindowsIdentity(token)) {
          if(identity.User==null) throw new IOException("PEER_USER_UNAVAILABLE");
          sid=identity.User.Value;
        }} finally {CloseHandle(token);}
        uint session;if(!ProcessIdToSessionId(id,out session)) throw new IOException("PEER_SESSION_UNAVAILABLE");
        ProcessProof result=new ProcessProof(handle,id,(uint)info.parentId.ToInt64(),session,Path.GetFullPath(name.ToString()),sid,((long)created.high<<32)|created.low);
        if(!result.Alive()) throw new IOException("PEER_PROCESS_EXITED");
        return result;
      } catch {handle.Dispose();throw;}
    }
    public static ProcessProof PipePeer(SafePipeHandle pipe, bool server) {
      uint id;
      bool found=server ? GetNamedPipeServerProcessId(pipe,out id) : GetNamedPipeClientProcessId(pipe,out id);
      if(!found) throw new IOException("PIPE_PEER_UNAVAILABLE");
      return Query(id);
    }
    public bool DirectChildOf(ProcessProof parent) {
      return parent!=null && parentId==parent.id && parent.created<=created && userSid==parent.userSid && sessionId==parent.sessionId && Alive() && parent.Alive();
    }
  }

  public static class BrowserBinaryProof {
    [StructLayout(LayoutKind.Sequential)] struct TrustFile { public uint size;public IntPtr path,handle,subject; }
    [StructLayout(LayoutKind.Sequential)] struct TrustData {
      public uint size;public IntPtr callback,sip;public uint ui,revocation,choice;public IntPtr file;
      public uint state;public IntPtr stateData,url;public uint flags,context;
    }
    [DllImport("wintrust.dll", ExactSpelling=true, SetLastError=false)] static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref TrustData data);
    static bool TrustedSignature(string path) {
      IntPtr name=Marshal.StringToCoTaskMemUni(path), file=IntPtr.Zero;
      TrustData data=new TrustData();
      Guid action=new Guid("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
      try {
        TrustFile info=new TrustFile {size=(uint)Marshal.SizeOf(typeof(TrustFile)),path=name};
        file=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TrustFile)));Marshal.StructureToPtr(info,file,false);
        data.size=(uint)Marshal.SizeOf(typeof(TrustData));data.ui=2;data.choice=1;data.file=file;data.state=1;
        data.flags=0x1000; // Cache-only trust retrieval: no network discovery from this helper.
        return WinVerifyTrust(new IntPtr(-1),ref action,ref data)==0;
      } finally {
        if(data.stateData!=IntPtr.Zero) {data.state=2;WinVerifyTrust(new IntPtr(-1),ref action,ref data);}
        if(file!=IntPtr.Zero) Marshal.FreeHGlobal(file);
        Marshal.FreeCoTaskMem(name);
      }
    }
    public static bool Verify(string path, string browser) {
      string expected=browser=="chrome" ? "chrome.exe" : browser=="edge" ? "msedge.exe" : null;
      if(expected==null || !String.Equals(Path.GetFileName(path),expected,StringComparison.OrdinalIgnoreCase)) return false;
      try {
        // Keep the image unmodified while the Windows signature and certificate are checked.
        using(FileStream held=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)) {
          if(held.Length<=0 || held.Length>268435456 || (File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0 || !TrustedSignature(path)) return false;
          using(X509Certificate2 certificate=new X509Certificate2(X509Certificate.CreateFromSignedFile(path))) {
            string organization=browser=="chrome" ? "Google LLC" : "Microsoft Corporation";
            return Regex.IsMatch(certificate.Subject,"(?:^|,\\s*)O="+Regex.Escape(organization)+"(?:,|$)");
          }
        }
      } catch {return false;}
    }
    public static string Hash(string path) {
      using(FileStream stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)) {
        if(stream.Length<=0 || stream.Length>268435456 || (File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0) throw new IOException("PEER_IMAGE_POLICY");
        using(SHA256 hash=SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant();
      }
    }
  }
}
