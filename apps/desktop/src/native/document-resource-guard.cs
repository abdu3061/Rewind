using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading.Tasks;

namespace Rewind.Documents {
  // This helper receives process IDs only. It never receives document bytes or paths.
  public static class ResourceGuard {
    sealed class Handle : Microsoft.Win32.SafeHandles.SafeHandleZeroOrMinusOneIsInvalid {
      public Handle() : base(true) {}
      [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
      protected override bool ReleaseHandle() { return CloseHandle(handle); }
    }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
      public long processTime, jobTime;
      public uint flags;
      public UIntPtr minWorkingSet, maxWorkingSet;
      public uint activeProcesses;
      public UIntPtr affinity;
      public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
      public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
      public BasicLimits basic;
      public IoCounters io;
      public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
      public IntPtr reserved1, peb, reserved2, reserved3, id, parent;
    }
    [DllImport("kernel32.dll", SetLastError=true)] static extern Handle OpenProcess(uint access, bool inherit, uint id);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern Handle CreateJobObjectW(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(Handle job, int kind, ref ExtendedLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(Handle job, int kind, out ExtendedLimits limits, uint length, out uint written);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(Handle job, Handle process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(Handle process, Handle job, out bool inside);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(Handle process, uint milliseconds);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageNameW(Handle process, uint flags, StringBuilder path, ref uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(Handle process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ProcessIdToSessionId(uint id, out uint session);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(Handle process, uint access, out Handle token);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(Handle process, int kind, out ProcessInfo info, uint length, out uint written);
    static void Require(bool value) { if(!value) throw new IOException("DOCUMENT_RESOURCE_ADMISSION_FAILED"); }
    static uint Parent(Handle process) {
      ProcessInfo info; uint written;
      Require(NtQueryInformationProcess(process,0,out info,(uint)Marshal.SizeOf(typeof(ProcessInfo)),out written)==0);
      return checked((uint)info.parent.ToInt64());
    }
    static string Image(Handle process) {
      StringBuilder path=new StringBuilder(32768); uint size=32768;
      Require(QueryFullProcessImageNameW(process,0,path,ref size) && size>0 && size<32768);
      return path.ToString();
    }
    static string User(Handle process) {
      Handle token;
      Require(OpenProcessToken(process,8,out token));
      using(token) using(WindowsIdentity user=new WindowsIdentity(token.DangerousGetHandle())) {
        Require(user.User!=null); return user.User.Value;
      }
    }
    static long Created(Handle process) {
      long created,exited,kernel,user;
      Require(GetProcessTimes(process,out created,out exited,out kernel,out user));return created;
    }
    public static int Main(string[] args) {
      try {
        uint parentId, childId;
        Require(args.Length==2 && uint.TryParse(args[0],out parentId) && uint.TryParse(args[1],out childId));
        // Parse again to satisfy the Framework compiler's definite-assignment analysis.
        parentId=uint.Parse(args[0]);childId=uint.Parse(args[1]);
        Require(parentId!=0 && childId!=0 && parentId!=childId);
        using(Handle self=OpenProcess(0x101000,false,(uint)Process.GetCurrentProcess().Id))
        using(Handle parent=OpenProcess(0x101000,false,parentId))
        using(Handle child=OpenProcess(0x101101,false,childId))
        using(Handle job=CreateJobObjectW(IntPtr.Zero,null)) {
          Require(!self.IsInvalid && !parent.IsInvalid && !child.IsInvalid && !job.IsInvalid);
          Require(Parent(self)==parentId && Parent(child)==parentId);
          Require(WaitForSingleObject(parent,0)==258 && WaitForSingleObject(child,0)==258);
          Require(Created(parent)<=Created(child) && Created(child)<=Created(self));
          Require(String.Equals(Image(parent),Image(child),StringComparison.OrdinalIgnoreCase));
          Require(User(parent)==User(child) && User(child)==User(self));
          uint parentSession,childSession;
          Require(ProcessIdToSessionId(parentId,out parentSession) && ProcessIdToSessionId(childId,out childSession) && parentSession==childSession);
          ExtendedLimits limits=new ExtendedLimits();
          // 512 MiB committed memory, one process, 15s user CPU, kill on guard close.
          limits.basic.flags=0x230a;
          limits.basic.processTime=15L*10000000;
          limits.basic.activeProcesses=1;
          limits.processMemory=new UIntPtr(512UL*1024*1024);
          limits.jobMemory=limits.processMemory;
          uint size=(uint)Marshal.SizeOf(typeof(ExtendedLimits));
          Require(SetInformationJobObject(job,9,ref limits,size));
          Require(AssignProcessToJobObject(job,child));
          ExtendedLimits actual;uint written;bool inside;
          Require(QueryInformationJobObject(job,9,out actual,size,out written));
          Require(actual.basic.flags==limits.basic.flags && actual.basic.processTime==limits.basic.processTime && actual.basic.activeProcesses==1 && actual.processMemory==limits.processMemory && actual.jobMemory==limits.jobMemory);
          Require(IsProcessInJob(child,job,out inside) && inside);
          Console.Out.WriteLine("DOCUMENT_RESOURCE_READY");Console.Out.Flush();
          Task<int> input=Task.Factory.StartNew(()=>Console.OpenStandardInput().ReadByte());
          Stopwatch elapsed=Stopwatch.StartNew();
          while(!input.IsCompleted && elapsed.ElapsedMilliseconds<30000) {
            if(WaitForSingleObject(child,100)==0) return 0;
            if(WaitForSingleObject(parent,0)!=258) return 1;
          }
          return 0; // Closing the sole job handle terminates a still-live child.
        }
      } catch { return 1; }
    }
  }
}
