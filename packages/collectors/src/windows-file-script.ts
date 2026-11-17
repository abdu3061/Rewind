// Compiled once per file-access helper. Only JSON requests on stdin; no captured bytes in argv/logs.
export const windowsFileScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public class RewindFolder { public string absolutePath; public string osIdentity; }
public class RewindListing { public string[] paths; public string[] stamps; public bool overflow; }
public class RewindBytes { public string base64; public string osIdentity; public long byteLength; }
public static class RewindFileAccess {
  [StructLayout(LayoutKind.Sequential)] public struct Info {
    public uint attributes, createdLow, createdHigh, accessedLow, accessedHigh, writtenLow, writtenHigh;
    public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out uint value, uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder name, uint size, uint flags);
  [DllImport("kernel32.dll")] static extern uint GetFileType(SafeFileHandle handle);
  sealed class Lease : IDisposable {
    public List<SafeFileHandle> handles = new List<SafeFileHandle>();
    public Info info;
    public SafeFileHandle last { get { return handles[handles.Count-1]; } }
    public void Dispose() { for(int i=handles.Count-1; i>=0; i--) handles[i].Dispose(); }
  }
  static string Identity(Info info) { return info.volume.ToString("x8")+":"+info.indexHigh.ToString("x8")+info.indexLow.ToString("x8"); }
  static string PathValue(string value) {
    if (String.IsNullOrEmpty(value) || value.Length>240 || value.Length<4 || !Char.IsLetter(value[0]) || value[1]!=':' || value[2]!='\\' || value.IndexOf(':',2)>=0 || value.IndexOf('/')>=0) throw new IOException("PATH_POLICY");
    string full = Path.GetFullPath(value).TrimEnd('\\');
    if (!String.Equals(full,value.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase)) throw new IOException("PATH_POLICY");
    foreach(string component in full.Substring(3).Split('\\')) {
      if(component.Length==0 || component.EndsWith(".") || component.EndsWith(" ")) throw new IOException("PATH_POLICY");
    }
    DriveInfo drive = new DriveInfo(full.Substring(0,3));
    if(drive.DriveType!=DriveType.Fixed || !String.Equals(drive.DriveFormat,"NTFS",StringComparison.OrdinalIgnoreCase)) throw new IOException("VOLUME_POLICY");
    return full;
  }
  static string Final(SafeFileHandle handle) {
    StringBuilder name = new StringBuilder(1024);
    uint length = GetFinalPathNameByHandleW(handle,name,1024,0);
    if(length==0 || length>=1024) throw new IOException("FINAL_PATH");
    string result = name.ToString();
    if(!result.StartsWith(@"\\?\")) throw new IOException("FINAL_PATH");
    return result.Substring(4).TrimEnd('\\');
  }
  static Lease LockPath(string value, bool file) {
    string full = PathValue(value);
    Lease lease = new Lease();
    try {
      string[] components = full.Substring(3).Split('\\');
      string current = full.Substring(0,3);
      for(int i=-1; i<components.Length; i++) {
        if(i>=0) current = Path.Combine(current,components[i]);
        bool lastFile = file && i==components.Length-1;
        // Directory ancestors deny deletion/rename; content reads deny write and delete sharing.
        SafeFileHandle handle = CreateFileW(current,lastFile ? 0x80000000u : 0u,lastFile ? 1u : 3u,IntPtr.Zero,3,0x02200000u,IntPtr.Zero);
        if(handle.IsInvalid) { handle.Dispose(); throw new IOException("OPEN_DENIED"); }
        lease.handles.Add(handle);
        Info info;
        if(!GetFileInformationByHandle(handle,out info) || GetFileType(handle)!=1 || (info.attributes & 0x400)!=0 || ((info.attributes & 0x10)==0)!=lastFile || (!lastFile && !String.Equals(Final(handle),current.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))) throw new IOException("IDENTITY_POLICY");
        if(lastFile && (info.links!=1 || !String.Equals(Final(handle),full,StringComparison.OrdinalIgnoreCase))) throw new IOException("FILE_IDENTITY_POLICY");
        if(!lastFile) { uint caseFlags; if(!GetFileInformationByHandleEx(handle,23,out caseFlags,4) || caseFlags!=0) throw new IOException("DIRECTORY_CASE_POLICY"); }
        lease.info = info;
      }
      return lease;
    } catch { lease.Dispose(); throw; }
  }
  static Lease Root(string root, string identity) {
    Lease lease = LockPath(root,false);
    if(!String.Equals(Identity(lease.info),identity,StringComparison.Ordinal)) { lease.Dispose(); throw new IOException("ROOT_CHANGED"); }
    return lease;
  }
  public static RewindFolder Folder(string root) {
    string full = PathValue(root);
    using(Lease lease = LockPath(full,false)) return new RewindFolder { absolutePath=full, osIdentity=Identity(lease.info) };
  }
  static bool Skip(string name) {
    string lower=name.ToLowerInvariant();
    return name.StartsWith(".") || name.StartsWith("~") || lower=="node_modules" || lower=="artifacts" || lower=="dist" || lower=="out";
  }
  public static RewindListing DirectoryEntries(string root, string identity) {
    root=PathValue(root);
    using(Lease selected=Root(root,identity)) {
      List<string> names=new List<string>();
      foreach(FileSystemInfo item in new DirectoryInfo(root).EnumerateFileSystemInfos()) {
        if(names.Count>=64 || (item.Attributes & FileAttributes.ReparsePoint)!=0) throw new IOException("DIRECTORY_ENTRIES_POLICY");
        names.Add(item.Name);
      }
      names.Sort(StringComparer.OrdinalIgnoreCase);
      string[] stamps=new string[names.Count];for(int i=0;i<stamps.Length;i++) stamps[i]="";
      return new RewindListing {paths=names.ToArray(),stamps=stamps,overflow=false};
    }
  }
  public static RewindListing List(string root, string identity) {
    root=PathValue(root);
    using(Lease selected = Root(root,identity)) {
      List<string> files = new List<string>();
      Dictionary<string,string> stamps = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
      Stack<string> pending = new Stack<string>(); pending.Push(root);
      int visited=0; bool overflow=false;
      while(pending.Count>0 && !overflow) {
        string directory=pending.Pop();
        using(Lease held=LockPath(directory,false)) {
          foreach(FileSystemInfo item in new DirectoryInfo(directory).EnumerateFileSystemInfos()) {
            string entry=item.FullName;
            if(++visited>2000) { overflow=true; break; }
            string name=Path.GetFileName(entry);
            if(Skip(name)) continue;
            FileAttributes attributes=item.Attributes;
            if((attributes & (FileAttributes.ReparsePoint|FileAttributes.Hidden|FileAttributes.System))!=0) continue;
            string relative=entry.Substring(root.Length+1);
            if(relative.Split('\\').Length>16 || entry.Length>240) { overflow=true; continue; }
            if((attributes & FileAttributes.Directory)!=0) pending.Push(entry); else {
              files.Add(relative); stamps[relative]=((FileInfo)item).Length.ToString()+":"+item.LastWriteTimeUtc.Ticks.ToString();
            }
          }
        }
      }
      files.Sort(StringComparer.OrdinalIgnoreCase);
      string[] fingerprints=new string[files.Count];
      for(int i=0; i<files.Count; i++) fingerprints[i]=stamps[files[i]];
      return new RewindListing { paths=files.ToArray(), stamps=fingerprints, overflow=overflow };
    }
  }
  public static RewindBytes Read(string root, string identity, string relative) {
    root=PathValue(root);
    if(String.IsNullOrEmpty(relative) || Path.IsPathRooted(relative) || relative.IndexOf(':')>=0 || relative.IndexOf('/')>=0) throw new IOException("RELATIVE_POLICY");
    foreach(string component in relative.Split('\\')) if(component=="." || component==".." || component.Length==0 || Skip(component)) throw new IOException("RELATIVE_POLICY");
    string full=PathValue(Path.Combine(root,relative));
    if(!full.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase)) throw new IOException("ROOT_SCOPE");
    using(Lease selected=Root(root,identity)) using(Lease held=LockPath(full,true)) {
      Info before=held.info;
      if((before.attributes & 6)!=0) throw new IOException("FILE_POLICY");
      ulong size=((ulong)before.sizeHigh<<32)|before.sizeLow;
      if(size>16777216) throw new IOException("FILE_LIMIT");
      byte[] bytes=new byte[(int)size];
      try {
        using(FileStream stream=new FileStream(held.last,FileAccess.Read,65536,false)) {
          int offset=0;
          while(offset<bytes.Length) { int count=stream.Read(bytes,offset,bytes.Length-offset); if(count==0) throw new IOException("SHORT_READ"); offset+=count; }
          Info after;
          if(stream.ReadByte()!=-1 || !GetFileInformationByHandle(held.last,out after) || after.links!=1 || Identity(before)!=Identity(after) || before.sizeHigh!=after.sizeHigh || before.sizeLow!=after.sizeLow || before.writtenHigh!=after.writtenHigh || before.writtenLow!=after.writtenLow) throw new IOException("FILE_CHANGED");
          return new RewindBytes { base64=Convert.ToBase64String(bytes), osIdentity=Identity(before), byteLength=(long)size };
        }
      } finally { Array.Clear(bytes,0,bytes.Length); }
    }
  }
}
'@ -Language CSharp
while ($null -ne ($line = [Console]::ReadLine())) {
  try {
    if ($line.Length -gt 32768) { exit 1 }
    $request = $line | ConvertFrom-Json
    $value = switch ($request.kind) {
      'folder' { [RewindFileAccess]::Folder([string]$request.path) }
      'directory' { [RewindFileAccess]::DirectoryEntries([string]$request.path,[string]$request.identity) }
      'list' { [RewindFileAccess]::List([string]$request.path,[string]$request.identity) }
      'read' { [RewindFileAccess]::Read([string]$request.path,[string]$request.identity,[string]$request.relative) }
      default { throw 'INVALID_COMMAND' }
    }
    [Console]::WriteLine((@{ ok=$true; value=$value } | ConvertTo-Json -Compress -Depth 6))
  } catch { [Console]::WriteLine('{"ok":false}') }
}
`.trim();
