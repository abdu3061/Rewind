import { windowsFileScript } from "./windows-file-script";

// Static trusted code only. Captured bytes and user-selected paths remain JSON data on stdin.
const copyTypes = String.raw`
public class RewindCopyReply {
  public string status, code, osIdentity, contentHash;
  public long byteLength;
  public bool cleanupConfirmed;
}
`;
const copyMethod = String.raw`
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref byte value, uint size);
  static string Digest(Stream stream) {
    using(System.Security.Cryptography.SHA256 sha=System.Security.Cryptography.SHA256.Create())
      return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();
  }
  public static RewindCopyReply Copy(string parent, string identity, string name, string base64, string expectedHash) {
    RewindCopyReply result=new RewindCopyReply {status="failed",code="unavailable",cleanupConfirmed=true};
    byte[] bytes=null; Lease directory=null; SafeFileHandle handle=null; FileStream stream=null;
    bool created=false;
    try {
      bytes=Convert.FromBase64String(base64);
      if(bytes.Length>16777216 || expectedHash==null || expectedHash.Length!=64) return result;
      using(MemoryStream data=new MemoryStream(bytes,false)) {
        if(Digest(data)!=expectedHash) {result.code="integrity";return result;}
      }
      if(String.IsNullOrEmpty(name) || name!=Path.GetFileName(name) || name.IndexOfAny(Path.GetInvalidFileNameChars())>=0 || name=="." || name=="..") return result;
      parent=PathValue(parent);
      string full=PathValue(Path.Combine(parent,name));
      directory=Root(parent,identity);
      // CREATE_NEW is unconditional: no existing destination, link or original file is overwritten.
      handle=CreateFileW(full,0xC0010000u,0,IntPtr.Zero,1,0x80200080u,IntPtr.Zero);
      if(handle.IsInvalid) {
        int error=Marshal.GetLastWin32Error();
        if(error==80 || error==183) result.code="conflict";
        return result;
      }
      created=true; result.cleanupConfirmed=false;
      Info before;
      if(!GetFileInformationByHandle(handle,out before) || GetFileType(handle)!=1 || before.links!=1 || (before.attributes & 0x410)!=0 || !String.Equals(Final(handle),full,StringComparison.OrdinalIgnoreCase)) return result;
      stream=new FileStream(handle,FileAccess.ReadWrite,65536,false);
      stream.Write(bytes,0,bytes.Length);
      stream.Flush(true);
      stream.Position=0;
      string actual=Digest(stream);
      Info after;
      if(actual!=expectedHash || stream.Length!=bytes.Length || !GetFileInformationByHandle(handle,out after) || after.links!=1 || Identity(before)!=Identity(after) || !String.Equals(Final(handle),full,StringComparison.OrdinalIgnoreCase)) {result.code="integrity";return result;}
      result.status="copied"; result.code="ok"; result.osIdentity=Identity(after); result.contentHash=actual; result.byteLength=bytes.Length; result.cleanupConfirmed=true;
      return result;
    } catch {return result;}
    finally {
      // Remove only the exact newly created object, never a path that could have been replaced.
      if(created && result.status!="copied" && handle!=null && !handle.IsInvalid && !handle.IsClosed) {
        byte remove=1;
        result.cleanupConfirmed=SetFileInformationByHandle(handle,4,ref remove,1);
      }
      try {if(stream!=null) stream.Dispose();} catch {result.status="failed";result.code="unavailable";result.cleanupConfirmed=false;}
      if(handle!=null) handle.Dispose();
      if(directory!=null) directory.Dispose();
      if(bytes!=null) Array.Clear(bytes,0,bytes.Length);
    }
  }
`;
function replaceOnce(
  source: string,
  marker: string,
  replacement: string,
): string {
  if (
    source.indexOf(marker) < 0 ||
    source.indexOf(marker) !== source.lastIndexOf(marker)
  )
    throw new Error("RECOVERY_HELPER_TEMPLATE_INVALID");
  return source.replace(marker, replacement);
}
// The bootstrap already selected UTF-8 before reading its first line. Resetting it here
// would discard the StreamReader's buffered command bytes from the same private pipe.
let script = replaceOnce(
  windowsFileScript,
  "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false",
  "# Input encoding selected by the trusted bootstrap.",
);
script = replaceOnce(
  script,
  "public static class RewindFileAccess {",
  `${copyTypes}\npublic static class RewindFileAccess {`,
);
script = replaceOnce(
  script,
  "  public static RewindBytes Read(",
  `${copyMethod}\n  public static RewindBytes Read(`,
);
script = replaceOnce(
  script,
  "if ($line.Length -gt 32768)",
  "if ($line.Length -gt 25165824)",
);
script = replaceOnce(
  script,
  "      default { throw 'INVALID_COMMAND' }",
  "      'copy' { [RewindFileAccess]::Copy([string]$request.path,[string]$request.identity,[string]$request.name,[string]$request.base64,[string]$request.hash) }\n      default { throw 'INVALID_COMMAND' }",
);
export const windowsCopyScript = script;
