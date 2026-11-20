// Static trusted code. Only public challenge/window metadata enters PowerShell;
// the key stays inside the native credential buffer and is sealed directly to the utility recipient.
export const credentialPromptCode = String.raw`
using System;
using System.Text;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
public class RewindCredentialReply { public string status="unavailable",id,sealedValue; }
public static class RewindCredentialPrompt {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct UiInfo {
    public int size;public IntPtr parent;public string message,caption;public IntPtr banner;
  }
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  [DllImport("credui.dll",CharSet=CharSet.Unicode)]
  static extern uint CredUIPromptForCredentialsW(ref UiInfo info,string target,IntPtr context,uint error,IntPtr username,uint userSize,IntPtr password,uint passwordSize,[MarshalAs(UnmanagedType.Bool)]ref bool save,uint flags);
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
  static void Wipe(IntPtr buffer,int size) {if(buffer!=IntPtr.Zero)for(int i=0;i<size;i++)Marshal.WriteByte(buffer,i,0);}
  static bool KeyCharacter(int value) {return (value>=65&&value<=90)||(value>=97&&value<=122)||(value>=48&&value<=57)||value==95||value==45;}
  static string Seal(IntPtr password,int length,string id,string modulus,string exponent) {
    Guid parsed;if(!Guid.TryParseExact(id,"D",out parsed)||length<16||length>256)return null;
    byte[] n=Convert.FromBase64String(modulus),e=Convert.FromBase64String(exponent),plain=null;
    if(n.Length!=512||e.Length!=3||Convert.ToBase64String(n)!=modulus||exponent!="AQAB")return null;
    byte[] prefix=Encoding.UTF8.GetBytes("{\"id\":\""+id+"\",\"apiKey\":\"");
    try {
      plain=new byte[prefix.Length+length+2];Buffer.BlockCopy(prefix,0,plain,0,prefix.Length);
      for(int i=0;i<length;i++){int value=(ushort)Marshal.ReadInt16(password,i*2);if(!KeyCharacter(value))return null;plain[prefix.Length+i]=(byte)value;}
      plain[plain.Length-2]=34;plain[plain.Length-1]=125;
      using(RSACng rsa=new RSACng()) {
        rsa.ImportParameters(new RSAParameters {Modulus=n,Exponent=e});
        return Convert.ToBase64String(rsa.Encrypt(plain,RSAEncryptionPadding.OaepSHA256));
      }
    } finally {if(plain!=null)Array.Clear(plain,0,plain.Length);}
  }
  public static RewindCredentialReply Prompt(string parent,uint owner,string id,string expiresAt,string modulus,string exponent) {
    RewindCredentialReply result=new RewindCredentialReply();IntPtr user=IntPtr.Zero,password=IntPtr.Zero;
    try {
      long value;DateTime expiry;Guid parsed;
      if(!Int64.TryParse(parent,out value)||value<=0||owner==0||!Guid.TryParseExact(id,"D",out parsed)||!DateTime.TryParseExact(expiresAt,"yyyy-MM-ddTHH:mm:ss.fffZ",CultureInfo.InvariantCulture,DateTimeStyles.AssumeUniversal|DateTimeStyles.AdjustToUniversal,out expiry)||expiry<=DateTime.UtcNow)return result;
      IntPtr window=new IntPtr(value);uint actualOwner;
      if(!IsWindow(window)||GetWindowThreadProcessId(window,out actualOwner)==0||actualOwner!=owner)return result;
      user=Marshal.AllocHGlobal(1024);password=Marshal.AllocHGlobal(514);Wipe(user,1024);Wipe(password,514);
      string username="Gemini API key";for(int i=0;i<username.Length;i++)Marshal.WriteInt16(user,i*2,username[i]);
      UiInfo info=new UiInfo {size=Marshal.SizeOf(typeof(UiInfo)),parent=window,caption="Rewind: configure Gemini",message="Enter a Gemini API key in the Password field. Rewind keeps it in encrypted local storage. Nothing is sent to Google until you separately approve a question.",banner=IntPtr.Zero};
      bool save=false;
      // Generic non-Windows credentials, always visible, no Windows Credential Manager persistence, fixed username.
      uint status=CredUIPromptForCredentialsW(ref info,"Rewind Gemini API",IntPtr.Zero,0,user,512,password,257,ref save,0x140082u);
      if(status==1223){result.status="cancelled";return result;}
      if(status!=0||expiry<=DateTime.UtcNow)return result;
      int length=0;while(length<257&&Marshal.ReadInt16(password,length*2)!=0)length++;
      string sealedValue=Seal(password,length,id,modulus,exponent);if(sealedValue==null)return result;
      result.status="sealed";result.id=id;result.sealedValue=sealedValue;return result;
    }catch{return result;}
    finally {Wipe(password,514);Wipe(user,1024);if(password!=IntPtr.Zero)Marshal.FreeHGlobal(password);if(user!=IntPtr.Zero)Marshal.FreeHGlobal(user);}
  }
}
`;
export const credentialPromptScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=New-Object Text.UTF8Encoding $false
[Console]::OutputEncoding=New-Object Text.UTF8Encoding $false
Add-Type -TypeDefinition @'
${credentialPromptCode}
'@ -Language CSharp
$line=[Console]::ReadLine()
if($null -eq $line -or $line.Length -gt 4096){exit 1}
try {
  $request=$line | ConvertFrom-Json
  $result=[RewindCredentialPrompt]::Prompt([string]$request.parent,[uint32]$request.owner,[string]$request.id,[string]$request.expiresAt,[string]$request.modulus,[string]$request.exponent)
  [Console]::WriteLine(($result | ConvertTo-Json -Compress))
} catch {[Console]::WriteLine('{"status":"unavailable","id":null,"sealedValue":null}')}
`.trim();
