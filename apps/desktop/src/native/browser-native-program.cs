using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace Rewind.NativeBrowser {
  // Only a data relay. Desktop/session authority and final message schemas belong to the Node utility.
  static class Wire {
    public const int MaxFrame=262144;
    static readonly UTF8Encoding utf8=new UTF8Encoding(false,true);
    static JavaScriptSerializer Json() { return new JavaScriptSerializer {MaxJsonLength=524288,RecursionLimit=12}; }
    public static byte[] Encode(object value) {return utf8.GetBytes(Json().Serialize(value));}
    public static Dictionary<string,object> Object(byte[] value) {
      Dictionary<string,object> result=Json().DeserializeObject(utf8.GetString(value)) as Dictionary<string,object>;
      if(result==null) throw new IOException("BRIDGE_JSON_INVALID");return result;
    }
    public static string Text(byte[] value) {return utf8.GetString(value);}
    public static bool Keys(Dictionary<string,object> value, params string[] keys) {
      if(value.Count!=keys.Length) return false;foreach(string key in keys) if(!value.ContainsKey(key)) return false;return true;
    }
    public static string String(Dictionary<string,object> value,string key,int limit) {
      object item;string text=value.TryGetValue(key,out item) ? item as string : null;
      if(System.String.IsNullOrEmpty(text) || text.Length>limit) throw new IOException("BRIDGE_FIELD_INVALID");return text;
    }
    static void ReadRest(Stream stream,byte[] value,int start) {
      while(start<value.Length) {int size=stream.Read(value,start,value.Length-start);if(size<=0) throw new IOException("BRIDGE_FRAME_TRUNCATED");start+=size;}
    }
    public static byte[] Read(Stream stream) {
      int first=stream.ReadByte();if(first<0) return null;
      int expired=0;
      // A synchronous redirected stdin read cannot always be cancelled by disposing its handle.
      // Terminate this relay on a partial-frame deadline; it owns no user data/filesystem mutation.
      using(Timer timer=new Timer((state)=>{Interlocked.Exchange(ref expired,1);Environment.Exit(1);},null,3000,Timeout.Infinite)) {
        byte[] header=new byte[4];header[0]=(byte)first;ReadRest(stream,header,1);
        uint size=(uint)header[0]|((uint)header[1]<<8)|((uint)header[2]<<16)|((uint)header[3]<<24);
        if(size==0 || size>MaxFrame) throw new IOException("BRIDGE_FRAME_LIMIT");
        byte[] value=new byte[(int)size];ReadRest(stream,value,0);utf8.GetString(value);
        if(Interlocked.CompareExchange(ref expired,0,0)!=0) throw new IOException("BRIDGE_FRAME_TIMEOUT");return value;
      }
    }
    public static void Write(Stream stream,byte[] value) {
      if(value==null || value.Length==0 || value.Length>MaxFrame) throw new IOException("BRIDGE_FRAME_LIMIT");
      utf8.GetString(value);
      byte[] header=new byte[] {(byte)value.Length,(byte)(value.Length>>8),(byte)(value.Length>>16),(byte)(value.Length>>24)};
      stream.Write(header,0,4);stream.Write(value,0,value.Length);stream.Flush();
    }
    public static byte[] Decode(string value) {
      if(value==null || value.Length>349528) throw new IOException("BRIDGE_FRAME_LIMIT");
      byte[] bytes=Convert.FromBase64String(value);
      if(bytes.Length==0 || bytes.Length>MaxFrame || Convert.ToBase64String(bytes)!=value) throw new IOException("BRIDGE_FRAME_INVALID");
      return bytes;
    }
  }

  sealed class BridgeConfig {
    public string pipeName,desktopPath,desktopHash,hostHash;
    public readonly List<string> origins=new List<string>();
    public readonly Dictionary<string,string> browsers=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
    static string Image(string value) {
      if(value==null || value.Length>240 || !Regex.IsMatch(value,"^[A-Za-z]:\\\\") || value.IndexOf(':',2)>=0 || value.IndexOf('/')>=0 || !String.Equals(Path.GetFullPath(value),value,StringComparison.OrdinalIgnoreCase)) throw new IOException("BRIDGE_IMAGE_POLICY");
      foreach(string component in value.Substring(3).Split('\\')) if(component.Length==0 || component.EndsWith(".") || component.EndsWith(" ")) throw new IOException("BRIDGE_IMAGE_POLICY");
      if(new DriveInfo(value.Substring(0,3)).DriveType!=DriveType.Fixed) throw new IOException("BRIDGE_IMAGE_POLICY");
      return value;
    }
    public static BridgeConfig Parse(byte[] bytes) {
      if(bytes.Length>16384) throw new IOException("BRIDGE_CONFIG_LIMIT");
      Dictionary<string,object> value=Wire.Object(bytes);
      if(!Wire.Keys(value,"version","pipeName","desktopPath","desktopHash","hostHash","origins","browsers") || !(value["version"] is int) || (int)value["version"]!=1) throw new IOException("BRIDGE_CONFIG_INVALID");
      BridgeConfig config=new BridgeConfig {pipeName=Wire.String(value,"pipeName",128),desktopPath=Image(Wire.String(value,"desktopPath",240)),desktopHash=Wire.String(value,"desktopHash",64),hostHash=Wire.String(value,"hostHash",64)};
      if(!Regex.IsMatch(config.pipeName,"^rewind[.][a-z0-9.]{1,120}$") || !Regex.IsMatch(config.desktopHash,"^[a-f0-9]{64}$") || !Regex.IsMatch(config.hostHash,"^[a-f0-9]{64}$")) throw new IOException("BRIDGE_CONFIG_INVALID");
      object[] origins=value["origins"] as object[],browsers=value["browsers"] as object[];
      if(origins==null || origins.Length==0 || origins.Length>4 || browsers==null || browsers.Length==0 || browsers.Length>4) throw new IOException("BRIDGE_CONFIG_INVALID");
      foreach(object item in origins) {string origin=item as string;if(origin==null || !Regex.IsMatch(origin,"^chrome-extension://[a-p]{32}/$") || config.origins.Contains(origin)) throw new IOException("BRIDGE_ORIGIN_INVALID");config.origins.Add(origin);}
      foreach(object item in browsers) {
        Dictionary<string,object> browser=item as Dictionary<string,object>;
        if(browser==null || !Wire.Keys(browser,"kind","path")) throw new IOException("BRIDGE_BROWSER_INVALID");
        string kind=Wire.String(browser,"kind",6),path=Image(Wire.String(browser,"path",240));
        if((kind!="chrome" && kind!="edge") || config.browsers.ContainsKey(path)) throw new IOException("BRIDGE_BROWSER_INVALID");config.browsers.Add(path,kind);
      }
      return config;
    }
    public static BridgeConfig LoadHost() {
      string file=Program.ImagePath+".json";
      if((File.GetAttributes(file)&FileAttributes.ReparsePoint)!=0) throw new IOException("BRIDGE_CONFIG_INVALID");
      using(FileStream stream=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.Read)) {
        if(stream.Length<=0 || stream.Length>16384) throw new IOException("BRIDGE_CONFIG_LIMIT");
        byte[] bytes=new byte[(int)stream.Length];int offset=0;
        while(offset<bytes.Length) {int count=stream.Read(bytes,offset,bytes.Length-offset);if(count==0) throw new IOException("BRIDGE_CONFIG_INVALID");offset+=count;}
        return Parse(bytes);
      }
    }
  }

  static class PeerPolicy {
    public static string Origin(string input,BridgeConfig config) {
      if(input==null || !Regex.IsMatch(input,"^chrome-extension://[a-p]{32}/?$")) throw new IOException("BRIDGE_ORIGIN_INVALID");
      string canonical=input.EndsWith("/") ? input : input+"/";
      if(!config.origins.Contains(canonical)) throw new IOException("BRIDGE_ORIGIN_FORBIDDEN");return canonical;
    }
    public static string BrowserParent(ProcessProof host,BridgeConfig config) {
      using(ProcessProof parent=ProcessProof.Query(host.parentId)) {
        if(!host.DirectChildOf(parent)) throw new IOException("BRIDGE_PARENT_INVALID");
        // Chromium may use the system command interpreter to launch a native executable.
        string command=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"cmd.exe");
        if(String.Equals(parent.path,command,StringComparison.OrdinalIgnoreCase)) {
          using(ProcessProof browser=ProcessProof.Query(parent.parentId)) {
            if(!parent.DirectChildOf(browser)) throw new IOException("BRIDGE_PARENT_INVALID");return Browser(browser,config);
          }
        }
        return Browser(parent,config);
      }
    }
    static string Browser(ProcessProof proof,BridgeConfig config) {
      string kind;
      if(!config.browsers.TryGetValue(proof.path,out kind) || !BrowserBinaryProof.Verify(proof.path,kind) || !proof.Alive()) throw new IOException("BRIDGE_BROWSER_FORBIDDEN");return kind;
    }
    public static void HostImage(ProcessProof peer,ProcessProof self,BridgeConfig config) {
      if(peer.userSid!=self.userSid || peer.sessionId!=self.sessionId || !peer.Alive() || !String.Equals(peer.path,Program.ImagePath,StringComparison.OrdinalIgnoreCase) || BrowserBinaryProof.Hash(peer.path)!=config.hostHash) throw new IOException("BRIDGE_HOST_FORBIDDEN");
    }
    public static ProcessProof DesktopParent(ProcessProof broker,BridgeConfig config) {
      ProcessProof desktop=ProcessProof.Query(broker.parentId);
      try {
        if(!broker.DirectChildOf(desktop) || !String.Equals(desktop.path,config.desktopPath,StringComparison.OrdinalIgnoreCase) || BrowserBinaryProof.Hash(desktop.path)!=config.desktopHash) throw new IOException("BRIDGE_DESKTOP_FORBIDDEN");
        return desktop;
      } catch {desktop.Dispose();throw;}
    }
  }

  sealed class ProcessWatch : IDisposable {
    readonly ProcessProof process;readonly Timer timer;readonly object gate=new object();bool closed;
    public ProcessWatch(ProcessProof proof) {process=proof;timer=new Timer(Check,null,500,500);}
    void Check(object state) {lock(gate) {if(!closed && !process.Alive()) Environment.Exit(1);}}
    public void Dispose() {lock(gate) {closed=true;timer.Dispose();}}
  }

  static class Host {
    public static int Run(string[] args) {
      if(args.Length<1 || args.Length>2 || (args.Length==2 && !Regex.IsMatch(args[1],"^--parent-window=[0-9]{1,20}$"))) return 1;
      BridgeConfig config=BridgeConfig.LoadHost();string origin=PeerPolicy.Origin(args[0],config);
      using(ProcessProof self=ProcessProof.Query((uint)Process.GetCurrentProcess().Id)) {
        if(BrowserBinaryProof.Hash(Program.ImagePath)!=config.hostHash) return 1;
        PeerPolicy.BrowserParent(self,config);
        using(NamedPipeClientStream pipe=new NamedPipeClientStream(".",config.pipeName,PipeDirection.InOut,PipeOptions.Asynchronous,TokenImpersonationLevel.Identification)) {
          pipe.Connect(2000);
          using(ProcessProof server=ProcessProof.PipePeer(pipe.SafePipeHandle,true)) {
          PeerPolicy.HostImage(server,self,config);
          using(ProcessProof desktop=PeerPolicy.DesktopParent(server,config))
          using(ProcessWatch lifetime=new ProcessWatch(server)) {
          Wire.Write(pipe,Wire.Encode(new Dictionary<string,object> {{"version",1},{"type","authenticate"},{"origin",origin}}));
          Stream input=Console.OpenStandardInput(),output=Console.OpenStandardOutput();
          int failed=0;
          Thread outgoing=new Thread(()=>{
            try {byte[] body;while((body=Wire.Read(input))!=null) Wire.Write(pipe,body);}
            catch {Interlocked.Exchange(ref failed,1);}
            finally {try {pipe.Dispose();} catch {}}
          });outgoing.IsBackground=true;outgoing.Start();
          try {byte[] body;while((body=Wire.Read(pipe))!=null) Wire.Write(output,body);}
          catch {Interlocked.Exchange(ref failed,1);}
          finally {pipe.Dispose();}
          return Interlocked.CompareExchange(ref failed,0,0)==0 ? 0 : 1;
          }
          }
        }
      }
    }
  }

  sealed class Broker : IDisposable {
    sealed class Channel {
      public string id;public NamedPipeServerStream stream;public readonly object writeLock=new object();
    }
    readonly BridgeConfig config;
    readonly Dictionary<string,Channel> channels=new Dictionary<string,Channel>();
    readonly object gate=new object(),output=new object();
    volatile bool stopped;
    NamedPipeServerStream listener;
    Broker(BridgeConfig value) {config=value;}
    void Emit(object value) {
      lock(output) {if(stopped) return;try {Console.Out.WriteLine(Wire.Text(Wire.Encode(value)));Console.Out.Flush();} catch {Environment.Exit(1);}}
    }
    void Close(Channel channel) {
      bool removed;lock(gate) {removed=channels.Remove(channel.id);}
      try {channel.stream.Dispose();} catch {}
      if(removed) Emit(new Dictionary<string,object> {{"type","disconnected"},{"channelId",channel.id}});
    }
    void Receive(Channel channel) {
      try {
        string browser,origin;
        using(ProcessProof peer=ProcessProof.PipePeer(channel.stream.SafePipeHandle,false))
        using(ProcessProof self=ProcessProof.Query((uint)Process.GetCurrentProcess().Id)) {
          PeerPolicy.HostImage(peer,self,config);browser=PeerPolicy.BrowserParent(peer,config);
          byte[] first=Wire.Read(channel.stream);if(first==null || first.Length>4096) throw new IOException("BRIDGE_AUTH_INVALID");
          Dictionary<string,object> auth=Wire.Object(first);
          if(!Wire.Keys(auth,"version","type","origin") || !(auth["version"] is int) || (int)auth["version"]!=1 || Wire.String(auth,"type",32)!="authenticate") throw new IOException("BRIDGE_AUTH_INVALID");
          origin=PeerPolicy.Origin(Wire.String(auth,"origin",64),config);
          if(!peer.Alive()) throw new IOException("BRIDGE_PEER_EXITED");
        }
        Emit(new Dictionary<string,object> {{"type","connected"},{"channelId",channel.id},{"browser",browser},{"origin",origin}});
        byte[] body;
        while(!stopped && (body=Wire.Read(channel.stream))!=null)
          Emit(new Dictionary<string,object> {{"type","message"},{"channelId",channel.id},{"payload",Convert.ToBase64String(body)}});
      } catch { /* No content, origins or process paths in diagnostics. */ }
      finally {Close(channel);}
    }
    void Accept() {
      try {
        while(!stopped) {
          NamedPipeServerStream accepted=listener;accepted.WaitForConnection();
          lock(gate) {
            if(stopped) {accepted.Dispose();return;}
            // Reserve a listening instance before handing the accepted anchor to another thread.
            // Four clients plus one listener is the complete bounded native resource budget.
            if(channels.Count>=4) {accepted.Dispose();throw new IOException("BRIDGE_CHANNEL_LIMIT");}
            listener=PrivatePipe.NextServer(config.pipeName,accepted);
            Channel channel=new Channel {id=Guid.NewGuid().ToString(),stream=accepted};channels.Add(channel.id,channel);
            Thread thread=new Thread(()=>Receive(channel));thread.IsBackground=true;thread.Start();
          }
        }
      } catch {if(!stopped) {Dispose();Environment.Exit(1);}}
    }
    void Send(Dictionary<string,object> message) {
      if(!Wire.Keys(message,"type","channelId","payload")) throw new IOException("BRIDGE_COMMAND_INVALID");
      string id=Wire.String(message,"channelId",36);Guid parsed;
      if(!Guid.TryParseExact(id,"D",out parsed)) throw new IOException("BRIDGE_CHANNEL_INVALID");
      Channel channel;lock(gate) {if(!channels.TryGetValue(id,out channel)) return;}
      byte[] body=Wire.Decode(Wire.String(message,"payload",349528));
      try {lock(channel.writeLock) Wire.Write(channel.stream,body);} catch {Close(channel);}
    }
    public void Dispose() {
      Channel[] owned;
      lock(gate) {if(stopped) return;stopped=true;owned=new List<Channel>(channels.Values).ToArray();channels.Clear();}
      try {if(listener!=null) listener.Dispose();} catch {}
      foreach(Channel channel in owned) try {channel.stream.Dispose();} catch {}
    }
    public static int Run() {
      Console.InputEncoding=new UTF8Encoding(false,true);Console.OutputEncoding=new UTF8Encoding(false,true);
      string first=Console.ReadLine();if(first==null || first.Length>16384) return 1;
      BridgeConfig config=BridgeConfig.Parse(Encoding.UTF8.GetBytes(first));
      using(ProcessProof self=ProcessProof.Query((uint)Process.GetCurrentProcess().Id)) {
        if(BrowserBinaryProof.Hash(Program.ImagePath)!=config.hostHash) return 1;
        using(ProcessProof desktop=PeerPolicy.DesktopParent(self,config))
        using(ProcessWatch lifetime=new ProcessWatch(desktop)) {
      using(Broker broker=new Broker(config)) {
        broker.listener=PrivatePipe.FirstServer(config.pipeName);
        Thread thread=new Thread(broker.Accept);thread.IsBackground=true;thread.Start();
        broker.Emit(new Dictionary<string,object> {{"type","ready"}});
        string line;
        while(!broker.stopped && (line=Console.ReadLine())!=null) {
          if(line.Length>524288) return 1;
          Dictionary<string,object> message=Wire.Object(Encoding.UTF8.GetBytes(line));string type=Wire.String(message,"type",32);
          if(type=="shutdown" && Wire.Keys(message,"type")) return 0;
          if(type!="send") return 1;broker.Send(message);
        }
        return 0;
      }
      }
      }
    }
  }

  public static class Program {
    public static readonly string ImagePath=Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
    public static int Main(string[] args) {
      try {return args.Length==1 && args[0]=="--broker" ? Broker.Run() : Host.Run(args);} catch {return 1;}
    }
  }
}
