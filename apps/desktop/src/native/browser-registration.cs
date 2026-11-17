using System;
using System.IO;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace Rewind.NativeBrowser {
  // Private setup primitive. Only the utility installer supplies owned manifest paths;
  // no browser or renderer message can invoke this mode. Empty keys are retained on removal.
  static class Registration {
    sealed class Entry {
      public bool exists,empty,valid;
      public string value;
    }
    [System.Runtime.InteropServices.DllImport("advapi32.dll",CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
    static extern int RegCreateKeyEx(Microsoft.Win32.SafeHandles.SafeRegistryHandle root,string name,int reserved,string klass,int options,int access,IntPtr security,out IntPtr result,out int disposition);
    [System.Runtime.InteropServices.DllImport("advapi32.dll")]
    static extern int RegCloseKey(IntPtr key);
    static bool Same(string a,string b) {return a!=null && b!=null && String.Equals(a,b,StringComparison.OrdinalIgnoreCase);}
    static Entry Read(Microsoft.Win32.RegistryKey root,string name) {
      using(Microsoft.Win32.RegistryKey key=root.OpenSubKey(name,false)) {
        if(key==null) return new Entry();
        string[] names=key.GetValueNames();
        if(key.SubKeyCount!=0) return new Entry {exists=true};
        if(names.Length==0) return new Entry {exists=true,empty=true};
        if(names.Length!=1 || names[0]!="" || key.GetValueKind("")!=Microsoft.Win32.RegistryValueKind.String) return new Entry {exists=true};
        string value=key.GetValue("",null,Microsoft.Win32.RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
        return new Entry {exists=true,valid=value!=null,value=value};
      }
    }
    static Microsoft.Win32.RegistryKey NewKey(Microsoft.Win32.RegistryKey root,string name,Microsoft.Win32.RegistryView view) {
      IntPtr handle;int disposition;
      int access=0x2001F | (view==Microsoft.Win32.RegistryView.Registry64 ? 0x100 : 0x200);
      if(RegCreateKeyEx(root.Handle,name,0,null,0,access,IntPtr.Zero,out handle,out disposition)!=0) throw new IOException("REGISTRATION_CREATE_FAILED");
      if(disposition!=1) {RegCloseKey(handle);throw new IOException("REGISTRATION_CREATE_RACE");}
      Microsoft.Win32.SafeHandles.SafeRegistryHandle safe=new Microsoft.Win32.SafeHandles.SafeRegistryHandle(handle,true);
      try {return Microsoft.Win32.RegistryKey.FromHandle(safe,view);} catch {safe.Dispose();throw;}
    }
    static string Manifest(object input) {
      string value=input as string;
      if(value==null || value.Length>240 || !Regex.IsMatch(value,"^[A-Za-z]:\\\\") || value.IndexOf(':',2)>=0 || value.IndexOf('/')>=0 || !value.EndsWith(".json",StringComparison.OrdinalIgnoreCase) || !Same(Path.GetFullPath(value),value)) throw new IOException("REGISTRATION_PATH_INVALID");
      foreach(string part in value.Substring(3).Split('\\')) if(part.Length==0 || part.EndsWith(".") || part.EndsWith(" ") || part.IndexOfAny(new char[] {'\0','\r','\n'})>=0) throw new IOException("REGISTRATION_PATH_INVALID");
      return value;
    }
    static void Reply(bool ok,string state,int views,string code) {
      if(ok) Console.WriteLine(new JavaScriptSerializer().Serialize(new Dictionary<string,object> {{"ok",true},{"value",new Dictionary<string,object> {{"state",state},{"registeredViews",views}}}}));
      else Console.WriteLine(new JavaScriptSerializer().Serialize(new Dictionary<string,object> {{"ok",false},{"error",new Dictionary<string,object> {{"code",code},{"message",code=="CONFLICT" ? "An existing browser host registration is not owned by this Rewind setup." : "Browser host registration could not be confirmed. Inspect setup before retrying."}}}}));
    }
    public static int Run() {
      try {
        string line=Console.ReadLine();
        if(line==null || line.Length>16384) throw new IOException("REGISTRATION_REQUEST_LIMIT");
        Dictionary<string,object> request=Wire.Object(Encoding.UTF8.GetBytes(line));
        if(!Wire.Keys(request,"version","operation","browser","name","manifest","previous") || !(request["version"] is int) || (int)request["version"]!=1) throw new IOException("REGISTRATION_REQUEST_INVALID");
        string operation=Wire.String(request,"operation",16),browser=Wire.String(request,"browser",6),host=Wire.String(request,"name",128),manifest=Manifest(request["manifest"]),previous=request["previous"]==null ? null : Manifest(request["previous"]);
        if((operation!="inspect" && operation!="install" && operation!="remove") || (browser!="chrome" && browser!="edge") || !Regex.IsMatch(host,"^(com[.]rewind[.]bridge|com[.]rewind[.]test[.][a-f0-9]{32})$")) throw new IOException("REGISTRATION_REQUEST_INVALID");
        if(operation!="install" && previous!=null) throw new IOException("REGISTRATION_REQUEST_INVALID");
        string mutexName="Local\\rewind.browser.registry."+System.Security.Principal.WindowsIdentity.GetCurrent().User.Value+"."+browser+"."+host;
        using(System.Threading.Mutex mutex=new System.Threading.Mutex(false,mutexName)) {
          bool held=false;
          try {
            try {held=mutex.WaitOne(0);} catch(System.Threading.AbandonedMutexException) {held=true;}
            if(!held) {Reply(false,null,0,"CONFLICT");return 0;}
            return Change(operation,browser,host,manifest,previous);
          } finally {if(held) mutex.ReleaseMutex();}
        }
      } catch {Reply(false,null,0,"UNAVAILABLE");return 0;}
    }
    static int Change(string operation,string browser,string host,string manifest,string previous) {
        string name="Software\\"+(browser=="chrome" ? "Google\\Chrome" : "Microsoft\\Edge")+"\\NativeMessagingHosts\\"+host;
        Microsoft.Win32.RegistryView[] views=new Microsoft.Win32.RegistryView[] {Microsoft.Win32.RegistryView.Registry64,Microsoft.Win32.RegistryView.Registry32};
        bool conflict=false;int owned=0;
        foreach(Microsoft.Win32.RegistryView view in views) {
          using(Microsoft.Win32.RegistryKey machine=Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine,view))
          using(Microsoft.Win32.RegistryKey user=Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.CurrentUser,view)) {
            if(Read(machine,name).exists) conflict=true;
            Entry entry=Read(user,name);
            if(entry.valid && Same(entry.value,manifest)) owned++;
            bool allowed=operation=="install"
              ? !entry.exists || (previous!=null && (entry.empty || (entry.valid && Same(entry.value,previous))))
              : !entry.exists || entry.empty || (entry.valid && Same(entry.value,manifest));
            if(!allowed) conflict=true;
          }
        }
        if(operation=="inspect") {Reply(true,conflict ? "conflict" : owned==2 ? "registered" : owned==0 ? "absent" : "partial",owned,null);return 0;}
        if(conflict) {Reply(false,null,0,"CONFLICT");return 0;}
        bool wrote=false;
        foreach(Microsoft.Win32.RegistryView view in views) {
          using(Microsoft.Win32.RegistryKey user=Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.CurrentUser,view)) {
            Entry current=Read(user,name);
            if(operation=="remove") {
              if(!current.exists || current.empty) continue;
              if(!current.valid || !Same(current.value,manifest)) throw new IOException("REGISTRATION_CHANGED");
              using(Microsoft.Win32.RegistryKey key=user.OpenSubKey(name,true)) {
                if(key==null || key.SubKeyCount!=0 || key.GetValueNames().Length!=1 || key.GetValueKind("")!=Microsoft.Win32.RegistryValueKind.String || !Same(key.GetValue("") as string,manifest)) throw new IOException("REGISTRATION_CHANGED");
                key.DeleteValue("",false);
              }
              Entry removed=Read(user,name);
              if(removed.exists && !removed.empty) throw new IOException("REGISTRATION_REMOVAL_UNCONFIRMED");
              continue;
            }
            if(wrote && current.valid && Same(current.value,manifest)) continue; // Shared WOW64 key.
            if(current.exists && !(previous!=null && (current.empty || (current.valid && Same(current.value,previous))))) throw new IOException("REGISTRATION_CHANGED");
            using(Microsoft.Win32.RegistryKey key=current.exists ? user.OpenSubKey(name,true) : NewKey(user,name,view)) {
              if(key==null || key.SubKeyCount!=0) throw new IOException("REGISTRATION_CHANGED");
              string[] names=key.GetValueNames();
              if(names.Length>1 || (names.Length==1 && (names[0]!="" || key.GetValueKind("")!=Microsoft.Win32.RegistryValueKind.String || !Same(key.GetValue("") as string,previous)))) throw new IOException("REGISTRATION_CHANGED");
              key.SetValue("",manifest,Microsoft.Win32.RegistryValueKind.String);key.Flush();
            }
            wrote=true;
            Entry installed=Read(user,name);
            if(!installed.valid || !Same(installed.value,manifest)) throw new IOException("REGISTRATION_WRITE_UNCONFIRMED");
          }
        }
        owned=0;
        foreach(Microsoft.Win32.RegistryView view in views) {
          using(Microsoft.Win32.RegistryKey user=Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.CurrentUser,view)) {
            Entry final=Read(user,name);
            if(final.valid && Same(final.value,manifest)) owned++;
            else if(final.exists && !final.empty) throw new IOException("REGISTRATION_CHANGED");
          }
          using(Microsoft.Win32.RegistryKey machine=Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine,view)) if(Read(machine,name).exists) throw new IOException("REGISTRATION_CHANGED");
        }
        if((operation=="install" && owned!=2) || (operation=="remove" && owned!=0)) throw new IOException("REGISTRATION_UNCONFIRMED");
        Reply(true,operation=="install" ? "registered" : "absent",owned,null);return 0;
    }
  }

}
