# Read-only Windows Media Foundation decoder regression probe.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tests/native-playback.ps1 file.mp4 [other.mp4 ...]
# NV12 proves H.264 decoding; PCM proves audio decoding. JSON output; any failed track exits 1.
param([Parameter(Mandatory=$true, ValueFromRemainingArguments=$true)][string[]]$Files)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace ShiliuNativePlayback {
[ComImport,Guid("70AE66F2-C809-4E4F-8915-BDCB406B7993"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IReader {
 [PreserveSig]int GetStreamSelection(int i,[MarshalAs(UnmanagedType.Bool)]out bool selected);
 [PreserveSig]int SetStreamSelection(int i,[MarshalAs(UnmanagedType.Bool)]bool selected);
 [PreserveSig]int GetNativeMediaType(int i,int index,out IntPtr type);
 [PreserveSig]int GetCurrentMediaType(int i,out IntPtr type);
 [PreserveSig]int SetCurrentMediaType(int i,IntPtr reserved,IntPtr type);
 [PreserveSig]int SetCurrentPosition(ref Guid format,IntPtr pos);
 [PreserveSig]int ReadSample(int stream,int controls,out int actual,out int flags,out long timestamp,out IntPtr sample);
 [PreserveSig]int Flush(int stream);
 [PreserveSig]int GetServiceForStream(int stream,ref Guid service,ref Guid iid,out IntPtr value);
 [PreserveSig]int GetPresentationAttribute(int stream,ref Guid key,IntPtr value);
}
public class TrackResult { public string Track; public string Output; public bool Ok; public string Error; public int StartSamples; public int EndSamples; public double Duration; public double LastTimestamp; public bool SeekChecked; }
public static class Probe {
 [DllImport("mfplat.dll")] static extern int MFStartup(int version,int flags);
 [DllImport("mfplat.dll")] static extern int MFShutdown();
 [DllImport("mfplat.dll")] static extern int MFCreateMediaType(out IntPtr type);
 [DllImport("mfreadwrite.dll",CharSet=CharSet.Unicode)] static extern int MFCreateSourceReaderFromURL(string url,IntPtr attributes,out IReader reader);
 [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int SetGuid(IntPtr self,ref Guid key,ref Guid value);
 static void Check(int hr,string stage) {if(hr<0)throw new Exception(stage+" HRESULT 0x"+unchecked((uint)hr).ToString("X8"));}
 static void Attribute(IntPtr type,string key,string value){var k=new Guid(key);var v=new Guid(value);var table=Marshal.ReadIntPtr(type);var fn=Marshal.ReadIntPtr(table,24*IntPtr.Size);Check(((SetGuid)Marshal.GetDelegateForFunctionPointer(fn,typeof(SetGuid)))(type,ref k,ref v),"SetGUID");}
 static int Samples(IReader r,int stream,out long last,long minimum=0){int count=0;last=0;for(int n=0;n<2000&&count<3;n++){int actual,flags;long stamp;IntPtr sample;int hr=r.ReadSample(stream,0,out actual,out flags,out stamp,out sample);try{Check(hr,"ReadSample");if((flags&1)!=0)throw new Exception("SourceReader error flag");if(sample!=IntPtr.Zero){if(stamp>=minimum)count++;last=stamp;}if((flags&2)!=0)break;}finally{if(sample!=IntPtr.Zero)Marshal.Release(sample);}}if(count<3)throw new Exception("Fewer than 3 decoded samples at requested position");return count;}
 public static TrackResult Run(string file,bool video){var result=new TrackResult{Track=video?"video":"audio",Output=video?"NV12":"PCM"};IReader r=null;IntPtr type=IntPtr.Zero;IntPtr prop=Marshal.AllocHGlobal(24);int stream=unchecked((int)(video?0xFFFFFFFC:0xFFFFFFFD));try{Check(MFStartup(0x20070,0),"MFStartup");Check(MFCreateSourceReaderFromURL(file,IntPtr.Zero,out r),"Open");Check(r.SetStreamSelection(unchecked((int)0xFFFFFFFE),false),"Deselect streams");Check(r.SetStreamSelection(stream,true),"Select "+result.Track);Check(MFCreateMediaType(out type),"MFCreateMediaType");Attribute(type,"48eba18e-f8c9-4687-bf11-0a74c9f96a8f",video?"73646976-0000-0010-8000-00aa00389b71":"73647561-0000-0010-8000-00aa00389b71");Attribute(type,"f7e34c9a-42e8-4714-b74b-cb29d72c35e5",video?"3231564e-0000-0010-8000-00aa00389b71":"00000001-0000-0010-8000-00aa00389b71");Check(r.SetCurrentMediaType(stream,IntPtr.Zero,type),"Configure decoded "+result.Output);long last;result.StartSamples=Samples(r,stream,out last);result.LastTimestamp=last/10000000.0;
 for(int i=0;i<24;i++)Marshal.WriteByte(prop,i,0);var key=new Guid("6c990d33-bb8e-477a-8598-0d5d96fcd88a");Check(r.GetPresentationAttribute(unchecked((int)0xFFFFFFFF),ref key,prop),"Read duration");if(Marshal.ReadInt16(prop)!=21)throw new Exception("Unexpected duration PROPVARIANT");long duration=Marshal.ReadInt64(prop,8);result.Duration=duration/10000000.0;if(duration<=0)throw new Exception("Invalid duration");for(int i=0;i<24;i++)Marshal.WriteByte(prop,i,0);Marshal.WriteInt16(prop,20);long seek=Math.Max(0,duration-15000000);Marshal.WriteInt64(prop,8,seek);var format=Guid.Empty;Check(r.SetCurrentPosition(ref format,prop),"Seek near end");result.EndSamples=Samples(r,stream,out last,seek);result.LastTimestamp=last/10000000.0;result.SeekChecked=true;result.Ok=true;
 }catch(Exception ex){result.Error=ex.Message;}finally{if(type!=IntPtr.Zero)Marshal.Release(type);if(r!=null)Marshal.ReleaseComObject(r);Marshal.FreeHGlobal(prop);MFShutdown();}return result;}
}
}
"@
$results = @()
$failed = $false
foreach ($file in $Files) {
  $resolved = (Resolve-Path -LiteralPath $file).Path
  $video = [ShiliuNativePlayback.Probe]::Run($resolved, $true)
  $audio = [ShiliuNativePlayback.Probe]::Run($resolved, $false)
  $ok = $video.Ok -and $audio.Ok
  if (-not $ok) { $failed = $true }
  $results += [pscustomobject]@{File=$resolved; Ok=$ok; Video=$video; Audio=$audio}
}
ConvertTo-Json -Depth 5 -InputObject $results
if ($failed) { exit 1 }
exit 0
