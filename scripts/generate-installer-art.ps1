$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$assets = Join-Path $PSScriptRoot '../apps/desktop/assets'
Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class RewindInstallerArt {
  static Color ColorOf(string value) { return ColorTranslator.FromHtml(value); }
  static void Text(Graphics graphics, string value, float size, FontStyle weight, string color, float x, float y) {
    using(var font = new Font("Segoe UI",size,weight,GraphicsUnit.Pixel))
    using(var brush = new SolidBrush(ColorOf(color))) graphics.DrawString(value,font,brush,x,y);
  }
  static byte[] Encode(Bitmap bitmap) {
    // A palette made for this interface keeps text crisp; the default GIF
    // encoder's web palette otherwise introduces visible dithering.
    using(var indexed = new Bitmap(bitmap.Width,bitmap.Height,PixelFormat.Format8bppIndexed)) {
      var palette=indexed.Palette;
      string[] colors={"#282b45","#62657e","#315f9c","#6652ae"};
      int next=0;
      for(int family=0;family<4;family++) {
        Color color=ColorOf(colors[family]);
        int count=family==3 ? 48 : 64;
        for(int i=0;i<count;i++) palette.Entries[next++]=Color.FromArgb(
          color.R+(255-color.R)*i/(count-1),color.G+(255-color.G)*i/(count-1),color.B+(255-color.B)*i/(count-1));
      }
      string[] exact={"#ffffff","#282b45","#62657e","#6652ae","#d6cfea","#f0edf9","#e1e1ee","#315f9c"};
      foreach(string value in exact) palette.Entries[next++]=ColorOf(value);
      while(next<256) palette.Entries[next++]=Color.White;
      indexed.Palette=palette;
      var rectangle=new Rectangle(0,0,bitmap.Width,bitmap.Height);
      var source=bitmap.LockBits(rectangle,ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
      var target=indexed.LockBits(rectangle,ImageLockMode.WriteOnly,PixelFormat.Format8bppIndexed);
      try {
        byte[] input=new byte[source.Stride*bitmap.Height], output=new byte[target.Stride*bitmap.Height];
        Marshal.Copy(source.Scan0,input,0,input.Length);
        var cache=new Dictionary<int,byte>();
        for(int y=0;y<bitmap.Height;y++) for(int x=0;x<bitmap.Width;x++) {
          int offset=y*source.Stride+x*4, b=input[offset],g=input[offset+1],r=input[offset+2];
          int rgb=(r<<16)|(g<<8)|b;
          byte match;
          if(!cache.TryGetValue(rgb,out match)) {
            int closest=int.MaxValue;match=0;
            for(int p=0;p<256;p++) {
              Color candidate=palette.Entries[p];
              int red=r-candidate.R,green=g-candidate.G,blue=b-candidate.B;
              int distance=red*red+green*green+blue*blue;
              if(distance<closest) {closest=distance;match=(byte)p;}
            }
            cache.Add(rgb,match);
          }
          output[y*target.Stride+x]=match;
        }
        Marshal.Copy(output,0,target.Scan0,output.Length);
      } finally { bitmap.UnlockBits(source);indexed.UnlockBits(target); }
      using(var stream=new MemoryStream()) {indexed.Save(stream,ImageFormat.Gif);return stream.ToArray();}
    }
  }
  static byte[] Frame(string assets, int tick) {
    using(var bitmap = new Bitmap(600,340))
    using(var graphics = Graphics.FromImage(bitmap)) {
      graphics.Clear(ColorOf("#ffffff"));
      graphics.SmoothingMode = SmoothingMode.AntiAlias;
      graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
      using(var border = new Pen(ColorOf("#e1e1ee"))) graphics.DrawRectangle(border,0,0,599,339);
      using(var icon = Image.FromFile(Path.Combine(assets,"rewind.png"))) graphics.DrawImage(icon,40,33,48,48);
      Text(graphics,"Rewind",25,FontStyle.Bold,"#282b45",100,30);
      Text(graphics,"WINDOWS SETUP",10,FontStyle.Regular,"#62657e",103,64);
      Text(graphics,"Setting up Rewind",29,FontStyle.Bold,"#282b45",40,119);
      Text(graphics,"Installing the app and creating your shortcuts.",16,FontStyle.Regular,"#62657e",42,166);
      Text(graphics,"Rewind will open when setup is complete.",14,FontStyle.Regular,"#62657e",42,194);
      using(var track = new SolidBrush(ColorOf("#f0edf9"))) graphics.FillRectangle(track,44,245,512,3);
      // Indeterminate activity only. The actual install percentage stays in the native taskbar.
      for(int i=0;i<3;i++) {
        using(var dot = new SolidBrush(ColorOf(i==tick%3 ? "#6652ae" : "#d6cfea"))) graphics.FillEllipse(dot,44+i*12,274,5,5);
      }
      Text(graphics,"Installing on this computer",12,FontStyle.Regular,"#62657e",86,265);
      return Encode(bitmap);
    }
  }
  // Combine original code-rendered GIF frames. No raster editing tool or image dependency.
  public static void Generate(string assets) {
    var first=Frame(assets,0);
    using(var output=File.Create(Path.Combine(assets,"installer.gif")))
    using(var writer=new BinaryWriter(output)) {
      writer.Write(Encoding.ASCII.GetBytes("GIF89a"));
      writer.Write(first,6,7);
      int firstColors=(first[10]&128)!=0 ? 3*(1<<((first[10]&7)+1)) : 0;
      writer.Write(first,13,firstColors);
      writer.Write(new byte[] { 0x21,0xff,11 }); writer.Write(Encoding.ASCII.GetBytes("NETSCAPE2.0"));
      writer.Write(new byte[] { 3,1,0,0,0 });
      for(int index=0;index<3;index++) {
        var frame=Frame(assets,index);
        int colors=3*(1<<((frame[10]&7)+1));
        int position=13+colors;
        while(frame[position]!=0x2c) {
          if(frame[position++]!=0x21) throw new InvalidDataException("GIF_FRAME_EXTENSION");
          position++;
          int size;
          while((size=frame[position++])!=0) position+=size;
        }
        writer.Write(new byte[] { 0x21,0xf9,4,4,35,0,0,0 });
        writer.Write(frame,position,9);
        writer.Write((byte)(0x80|(frame[10]&7)));
        writer.Write(frame,13,colors);
        position+=10;
        writer.Write(frame,position,frame.Length-position-1);
      }
      writer.Write((byte)0x3b);
    }
    using(var preview=Image.FromFile(Path.Combine(assets,"installer.gif")))
      preview.Save(Path.Combine(assets,"installer-preview.png"),ImageFormat.Png);
  }
}
'@ -ReferencedAssemblies System.Drawing
[RewindInstallerArt]::Generate([IO.Path]::GetFullPath($assets))
