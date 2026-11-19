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
public class RewindScanListing : RewindListing { public bool continuation; public int skipped; }
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
    return name.StartsWith(".") || name.StartsWith("~") || lower=="node_modules" || lower=="artifacts" || lower=="dist" || lower=="out" || lower=="cache" || lower=="caches" || lower=="temp" || lower=="tmp";
  }
  sealed class ChangeHint { public DateTime first, last; }
  sealed class ChangeWatch : IDisposable {
    public string root, identity;
    public FileSystemWatcher watcher;
    public object gate = new object();
    public bool overflow;
    public Dictionary<string,ChangeHint> pending = new Dictionary<string,ChangeHint>(StringComparer.OrdinalIgnoreCase);
    public void Add(string full) {
      if(!full.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase) || full.Length>240) return;
      string relative=full.Substring(root.Length+1);
      string[] components=relative.Split('\\');
      if(components.Length>16) return;
      foreach(string part in components) if(Skip(part)) return;
      string ext=Path.GetExtension(relative).ToLowerInvariant();
      string name=Path.GetFileName(relative).ToLowerInvariant();
      if(("|.txt|.md|.ts|.tsx|.js|.jsx|.json|.css|.html|.xml|.csv|.yaml|.yml|.sql|.py|.pdf|.docx|").IndexOf("|"+ext+"|",StringComparison.Ordinal)<0 && name!="readme" && name!="license" && name!="makefile") return;
      lock(gate) {
        ChangeHint hint;
        DateTime now=DateTime.UtcNow;
        if(pending.TryGetValue(relative,out hint)) hint.last=now;
        else if(pending.Count<2000) pending.Add(relative,new ChangeHint { first=now,last=now });
        else overflow=true;
      }
    }
    public void Dispose() { watcher.Dispose(); }
  }
  static Dictionary<string,ChangeWatch> watches = new Dictionary<string,ChangeWatch>(StringComparer.OrdinalIgnoreCase);
  public static bool Watch(string root, string identity) {
    root=PathValue(root);
    using(Lease selected=Root(root,identity)) {
      ChangeWatch existing;
      if(watches.TryGetValue(root,out existing)) {
        if(existing.identity!=identity) throw new IOException("ROOT_CHANGED");
        return true;
      }
      if(watches.Count>=100) throw new IOException("WATCH_LIMIT");
      ChangeWatch watch=new ChangeWatch { root=root,identity=identity };
      watch.watcher=new FileSystemWatcher(root) { IncludeSubdirectories=true, NotifyFilter=NotifyFilters.LastWrite|NotifyFilters.Size|NotifyFilters.FileName, InternalBufferSize=16384 };
      watch.watcher.Changed+=(sender,args)=>watch.Add(args.FullPath);
      watch.watcher.Created+=(sender,args)=>watch.Add(args.FullPath);
      watch.watcher.Renamed+=(sender,args)=>watch.Add(args.FullPath);
      watch.watcher.Error+=(sender,args)=> { lock(watch.gate) watch.overflow=true; };
      try { watch.watcher.EnableRaisingEvents=true; watches.Add(root,watch); return true; }
      catch { watch.Dispose(); throw; }
    }
  }
  public static RewindListing Changes(string root, string identity) {
    root=PathValue(root);
    using(Lease selected=Root(root,identity)) {
      ChangeWatch watch;
      if(!watches.TryGetValue(root,out watch) || watch.identity!=identity) throw new IOException("WATCH_UNAVAILABLE");
      List<string> ready=new List<string>();
      bool overflow;
      lock(watch.gate) {
        overflow=watch.overflow;
        DateTime now=DateTime.UtcNow;
        foreach(KeyValuePair<string,ChangeHint> pair in watch.pending)
          if((now-pair.Value.last).TotalMilliseconds>=400 || (now-pair.Value.first).TotalMilliseconds>=2000) ready.Add(pair.Key);
        foreach(string relative in ready) watch.pending.Remove(relative);
      }
      List<string> paths=new List<string>(), stamps=new List<string>();
      foreach(string relative in ready) {
        try {
          string full=PathValue(Path.Combine(root,relative));
          using(Lease held=LockPath(full,true)) {
            if((held.info.attributes & 6)!=0) continue;
            paths.Add(relative); stamps.Add(held.info.sizeHigh.ToString()+":"+held.info.sizeLow.ToString()+":"+held.info.writtenHigh.ToString()+":"+held.info.writtenLow.ToString());
          }
        } catch(IOException) {
          // Unverified hints never authorize reads. The collector retries through
          // Read's native proof, with a bounded retry count, without following paths here.
          paths.Add(relative); stamps.Add("pending");
        } catch(UnauthorizedAccessException) { }
      }
      return new RewindListing { paths=paths.ToArray(),stamps=stamps.ToArray(),overflow=overflow };
    }
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
  sealed class ScanFrame : IDisposable {
    public string path, identity;
    public IEnumerator<FileSystemInfo> entries;
    public void Dispose() { if(entries!=null) entries.Dispose(); }
  }
  sealed class Scan : IDisposable {
    public string identity;
    public Stack<ScanFrame> frames = new Stack<ScanFrame>();
    public void Dispose() { while(frames.Count>0) frames.Pop().Dispose(); }
  }
  static Dictionary<string,Scan> scans = new Dictionary<string,Scan>(StringComparer.OrdinalIgnoreCase);
  static ScanFrame OpenScan(string directory) {
    using(Lease held=LockPath(directory,false)) return new ScanFrame {
      path=directory, identity=Identity(held.info), entries=new DirectoryInfo(directory).EnumerateFileSystemInfos().GetEnumerator()
    };
  }
  public static RewindScanListing List(string root, string identity) {
    root=PathValue(root);
    using(Lease selected = Root(root,identity)) {
      Scan scan;
      if(!scans.TryGetValue(root,out scan)) {
        if(scans.Count>=100) throw new IOException("SCAN_LIMIT");
        scan=new Scan { identity=identity }; scan.frames.Push(OpenScan(root)); scans.Add(root,scan);
      }
      if(scan.identity!=identity) { scan.Dispose(); scans.Remove(root); throw new IOException("ROOT_CHANGED"); }
      List<string> files = new List<string>();
      Dictionary<string,string> stamps = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
      int visited=0, skipped=0;
      System.Diagnostics.Stopwatch clock=System.Diagnostics.Stopwatch.StartNew();
      while(scan.frames.Count>0 && visited<2000 && clock.ElapsedMilliseconds<500) {
        ScanFrame frame=scan.frames.Peek();
        try {
          using(Lease held=LockPath(frame.path,false)) {
            if(Identity(held.info)!=frame.identity) throw new IOException("DIRECTORY_CHANGED");
            if(!frame.entries.MoveNext()) { scan.frames.Pop().Dispose(); continue; }
            FileSystemInfo item=frame.entries.Current;
            string entry=item.FullName;
            visited++;
            string name=Path.GetFileName(entry);
            if(Skip(name)) continue;
            try {
              FileAttributes attributes=item.Attributes;
              if((attributes & (FileAttributes.ReparsePoint|FileAttributes.Hidden|FileAttributes.System))!=0) continue;
              string relative=entry.Substring(root.Length+1);
              if(relative.Split('\\').Length>16 || entry.Length>240) { skipped++; continue; }
              if((attributes & FileAttributes.Directory)!=0) scan.frames.Push(OpenScan(entry)); else {
                string stamp=((FileInfo)item).Length.ToString()+":"+item.LastWriteTimeUtc.Ticks.ToString();
                files.Add(relative); stamps[relative]=stamp;
              }
            } catch(UnauthorizedAccessException) { skipped++; }
              catch(IOException) { skipped++; }
          }
        } catch(UnauthorizedAccessException) {
          if(frame.path==root) { scan.Dispose(); scans.Remove(root); throw; }
          if(scan.frames.Peek()==frame) scan.frames.Pop().Dispose();
          skipped++;
        } catch(IOException) {
          if(frame.path==root) { scan.Dispose(); scans.Remove(root); throw; }
          if(scan.frames.Peek()==frame) scan.frames.Pop().Dispose();
          skipped++;
        }
      }
      files.Sort(StringComparer.OrdinalIgnoreCase);
      string[] fingerprints=new string[files.Count];
      for(int i=0; i<files.Count; i++) fingerprints[i]=stamps[files[i]];
      bool more=scan.frames.Count>0;
      if(!more) { scan.Dispose(); scans.Remove(root); }
      return new RewindScanListing { paths=files.ToArray(), stamps=fingerprints, overflow=false, continuation=more, skipped=Math.Min(skipped,2000) };
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
      'watch' { [RewindFileAccess]::Watch([string]$request.path,[string]$request.identity) }
      'changes' { [RewindFileAccess]::Changes([string]$request.path,[string]$request.identity) }
      'directory' { [RewindFileAccess]::DirectoryEntries([string]$request.path,[string]$request.identity) }
      'list' {
        $page = [RewindFileAccess]::List([string]$request.path,[string]$request.identity)
        $result = @{ paths=$page.paths; stamps=$page.stamps; overflow=$page.overflow }
        if ($page.continuation) { $result.continuation = $true }
        if ($page.skipped -gt 0) { $result.skipped = $page.skipped }
        $result
      }
      'read' { [RewindFileAccess]::Read([string]$request.path,[string]$request.identity,[string]$request.relative) }
      default { throw 'INVALID_COMMAND' }
    }
    [Console]::WriteLine((@{ ok=$true; value=$value } | ConvertTo-Json -Compress -Depth 6))
  } catch { [Console]::WriteLine('{"ok":false}') }
}
`.trim();
