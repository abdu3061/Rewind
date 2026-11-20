import { windowsCopyScript } from "./windows-copy-script";

// This is a private primitive, never a renderer command. All paths/bytes follow as JSON data.
const types = String.raw`
public class RewindOverwriteEvidence {
  public string osIdentity, contentHash, lastWriteToken;
  public long byteLength;
}
public class RewindOverwriteReply {
  public string status="failed", code="unavailable";
  public RewindOverwriteEvidence target, preserved;
  public bool targetTouched, originalRestored;
}
`;
const methods = String.raw`
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool DeviceIoControl(SafeFileHandle file,uint code,IntPtr input,uint inputSize,IntPtr output,uint outputSize,IntPtr returned,IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool CancelIoEx(SafeFileHandle file,IntPtr overlapped);
  [StructLayout(LayoutKind.Sequential)] struct OverlappedRequest {
    public IntPtr internalLow, internalHigh;
    public uint offset, offsetHigh;
    public IntPtr eventHandle;
  }
  // An exclusive RW oplock also rejects writable mappings that outlive their original file handle.
  // Buffers remain unmanaged and pinned until the pending request has actually completed.
  sealed class ExclusiveOplock : IDisposable {
    static readonly List<ExclusiveOplock> stranded=new List<ExclusiveOplock>();
    readonly SafeFileHandle file;
    readonly System.Threading.EventWaitHandle signal=new System.Threading.EventWaitHandle(false,System.Threading.EventResetMode.ManualReset);
    IntPtr input, output, request;
    bool pending;
    public ExclusiveOplock(SafeFileHandle file) {
      this.file=file;
      try {
        input=Marshal.AllocHGlobal(12);output=Marshal.AllocHGlobal(24);
        request=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(OverlappedRequest)));
        Marshal.WriteInt16(input,0,1);Marshal.WriteInt16(input,2,12);
        Marshal.WriteInt32(input,4,3);Marshal.WriteInt32(input,8,1);
        Marshal.StructureToPtr(new OverlappedRequest {eventHandle=signal.SafeWaitHandle.DangerousGetHandle()},request,false);
        bool immediate=DeviceIoControl(file,0x00090240u,input,12,output,24,IntPtr.Zero,request);
        pending=!immediate && Marshal.GetLastWin32Error()==997;
        if(!pending) throw new IOException("EXCLUSIVE_OPLOCK_REQUIRED");
        Check();
      } catch {Dispose();throw;}
    }
    public void Check() { if(!pending || signal.WaitOne(0)) throw new IOException("EXCLUSIVE_OPLOCK_BROKEN"); }
    public void Dispose() {
      if(pending) {
        CancelIoEx(file,request);
        if(!signal.WaitOne(2000)) {
          // Retain both the buffers and event owner until the one-shot process exits.
          stranded.Add(this);throw new IOException("OPLOCK_CANCELLATION_PENDING");
        }
        pending=false;
      }
      if(request!=IntPtr.Zero) {Marshal.FreeHGlobal(request);request=IntPtr.Zero;}
      if(output!=IntPtr.Zero) {Marshal.FreeHGlobal(output);output=IntPtr.Zero;}
      if(input!=IntPtr.Zero) {Marshal.FreeHGlobal(input);input=IntPtr.Zero;}
      signal.Dispose();
    }
  }
  static bool RecoveryName(string name) {
    return !String.IsNullOrEmpty(name) && name==Path.GetFileName(name) && name.IndexOfAny(Path.GetInvalidFileNameChars())<0 && name!="." && name!=".." && !name.EndsWith(".") && !name.EndsWith(" ");
  }
  static Info RecoveryInfo(SafeFileHandle handle,string full) {
    Info info;
    if(!GetFileInformationByHandle(handle,out info) || GetFileType(handle)!=1 || info.links!=1 || (info.attributes & 0x417)!=0 || !String.Equals(Final(handle),full,StringComparison.OrdinalIgnoreCase) || info.sizeHigh!=0 || info.sizeLow>16777216) throw new IOException("RECOVERY_FILE_POLICY");
    return info;
  }
  static RewindOverwriteEvidence Evidence(Info info,string hash) {
    return new RewindOverwriteEvidence {osIdentity=Identity(info),contentHash=hash,byteLength=info.sizeLow,lastWriteToken=info.writtenHigh.ToString("x8")+info.writtenLow.ToString("x8")};
  }
  static bool SameEvidence(RewindOverwriteEvidence actual,string identity,string hash,long size,string written) {
    return actual.osIdentity==identity && actual.contentHash==hash && actual.byteLength==size && actual.lastWriteToken==written;
  }
  public static RewindOverwriteReply InspectOverwrite(string parent,string identity,string name) {
    RewindOverwriteReply result=new RewindOverwriteReply();
    try {
      if(!RecoveryName(name)) return result;
      parent=PathValue(parent);string full=PathValue(Path.Combine(parent,name));
      using(Lease directory=Root(parent,identity)) using(Lease held=LockPath(full,true)) {
        Info before=RecoveryInfo(held.last,full);
        using(FileStream stream=new FileStream(held.last,FileAccess.Read,65536,false)) {
          string hash=Digest(stream);Info after=RecoveryInfo(held.last,full);
          if(Identity(before)!=Identity(after) || before.sizeLow!=after.sizeLow || before.writtenHigh!=after.writtenHigh || before.writtenLow!=after.writtenLow) {result.code="conflict";return result;}
          result.target=Evidence(after,hash);result.status="inspected";result.code="ok";return result;
        }
      }
    } catch {return result;}
  }
  public static RewindOverwriteReply Overwrite(string parent,string parentIdentity,string name,string expectedIdentity,string expectedHash,long expectedSize,string expectedWritten,string backupName,string base64,string sourceHash) {
    RewindOverwriteReply result=new RewindOverwriteReply();
    byte[] source=null,current=null;Lease directory=null;SafeFileHandle targetHandle=null,backupHandle=null;
    FileStream target=null,backup=null;ExclusiveOplock oplock=null;
    bool backupCreated=false,backupVerified=false;
    try {
      if(!RecoveryName(name) || !RecoveryName(backupName) || String.Equals(name,backupName,StringComparison.OrdinalIgnoreCase)) return result;
      source=Convert.FromBase64String(base64);
      if(source.Length>16777216 || expectedSize<0 || expectedSize>16777216) return result;
      using(MemoryStream data=new MemoryStream(source,false)) if(Digest(data)!=sourceHash) {result.code="integrity";return result;}
      parent=PathValue(parent);string full=PathValue(Path.Combine(parent,name)),backupPath=PathValue(Path.Combine(parent,backupName));
      directory=Root(parent,parentIdentity);
      // OPEN_EXISTING, exclusive sharing, asynchronous I/O for the required RW oplock. Never truncate at open.
      targetHandle=CreateFileW(full,0xC0000000u,0,IntPtr.Zero,3,0xC0200080u,IntPtr.Zero);
      if(targetHandle.IsInvalid) {result.code="conflict";return result;}
      oplock=new ExclusiveOplock(targetHandle);
      Info before=RecoveryInfo(targetHandle,full);
      target=new FileStream(targetHandle,FileAccess.ReadWrite,65536,true);
      current=new byte[(int)before.sizeLow];
      int offset=0;
      while(offset<current.Length) {int count=target.Read(current,offset,current.Length-offset);if(count==0) throw new IOException("SHORT_READ");offset+=count;}
      if(target.ReadByte()!=-1) {result.code="conflict";return result;}
      string currentHash;
      using(MemoryStream data=new MemoryStream(current,false)) currentHash=Digest(data);
      Info verified=RecoveryInfo(targetHandle,full);
      result.target=Evidence(verified,currentHash);
      if(!SameEvidence(result.target,expectedIdentity,expectedHash,expectedSize,expectedWritten) || before.writtenHigh!=verified.writtenHigh || before.writtenLow!=verified.writtenLow) {result.code="conflict";return result;}
      oplock.Check();
      // A separate ordinary file in the selected directory is fully flushed and verified before any target mutation.
      backupHandle=CreateFileW(backupPath,0xC0010000u,0,IntPtr.Zero,1,0x80200080u,IntPtr.Zero);
      if(backupHandle.IsInvalid) {result.code="conflict";return result;}
      backupCreated=true;
      Info backupBefore=RecoveryInfo(backupHandle,backupPath);
      backup=new FileStream(backupHandle,FileAccess.ReadWrite,65536,false);
      backup.Write(current,0,current.Length);backup.Flush(true);backup.Position=0;
      string backupHash=Digest(backup);Info backupAfter=RecoveryInfo(backupHandle,backupPath);
      if(backupHash!=expectedHash || backup.Length!=expectedSize || Identity(backupBefore)!=Identity(backupAfter)) {result.code="integrity";return result;}
      backupVerified=true;result.preserved=Evidence(backupAfter,backupHash);
      oplock.Check();target.Position=0;
      if(Digest(target)!=expectedHash || !SameEvidence(Evidence(RecoveryInfo(targetHandle,full),expectedHash),expectedIdentity,expectedHash,expectedSize,expectedWritten)) {result.code="conflict";return result;}
      oplock.Check();
      result.targetTouched=true;target.Position=0;
      target.Write(source,0,source.Length);target.SetLength(source.Length);target.Flush(true);target.Position=0;
      string writtenHash=Digest(target);Info after=RecoveryInfo(targetHandle,full);
      if(writtenHash!=sourceHash || target.Length!=source.Length || Identity(before)!=Identity(after)) throw new IOException("OUTPUT_VERIFICATION");
      result.target=Evidence(after,writtenHash);result.status="replaced";result.code="ok";
      return result;
    } catch {
      // Best-effort rollback uses the same exclusive handle. Durable verified backup is always retained after write begins.
      if(result.targetTouched && target!=null && current!=null) {
        try {target.Position=0;target.Write(current,0,current.Length);target.SetLength(current.Length);target.Flush(true);target.Position=0;
          result.originalRestored=Digest(target)==expectedHash && target.Length==expectedSize;
        } catch {result.originalRestored=false;}
      }
      return result;
    } finally {
      if(backupCreated && !backupVerified && backupHandle!=null && !backupHandle.IsInvalid && !backupHandle.IsClosed) {byte remove=1;SetFileInformationByHandle(backupHandle,4,ref remove,1);}
      try {if(oplock!=null) oplock.Dispose();} catch {result.status="failed";result.code="unavailable";}
      try {if(target!=null) target.Dispose();} catch {result.status="failed";result.code="unavailable";}
      try {if(backup!=null) backup.Dispose();} catch {result.status="failed";result.code="unavailable";}
      if(targetHandle!=null) targetHandle.Dispose();if(backupHandle!=null) backupHandle.Dispose();
      if(directory!=null) directory.Dispose();
      if(source!=null) Array.Clear(source,0,source.Length);if(current!=null) Array.Clear(current,0,current.Length);
    }
  }
`;
function insert(source: string, marker: string, value: string) {
  if (
    source.indexOf(marker) < 0 ||
    source.indexOf(marker) !== source.lastIndexOf(marker)
  )
    throw new Error("OVERWRITE_HELPER_TEMPLATE_INVALID");
  return source.replace(marker, value);
}
let script = insert(
  windowsCopyScript,
  "public static class RewindFileAccess {",
  `${types}\npublic static class RewindFileAccess {`,
);
script = insert(
  script,
  "  public static RewindBytes Read(",
  `${methods}\n  public static RewindBytes Read(`,
);
script = insert(
  script,
  "      default { throw 'INVALID_COMMAND' }",
  `      'inspect-overwrite' { [RewindFileAccess]::InspectOverwrite([string]$request.path,[string]$request.identity,[string]$request.name) }
      'overwrite' { [RewindFileAccess]::Overwrite([string]$request.path,[string]$request.identity,[string]$request.name,[string]$request.expectedIdentity,[string]$request.expectedHash,[long]$request.expectedSize,[string]$request.expectedWritten,[string]$request.backupName,[string]$request.base64,[string]$request.hash) }
      default { throw 'INVALID_COMMAND' }`,
);
export const windowsOverwriteScript = script;
