$ErrorActionPreference='Stop'
try{
 Add-Type -AssemblyName PresentationCore
 Add-Type -AssemblyName WindowsBase
 $inputStream=[Console]::OpenStandardInput();$memory=[IO.MemoryStream]::new();$chunk=New-Object byte[] 65536
 while(($n=$inputStream.Read($chunk,0,$chunk.Length)) -gt 0){$memory.Write($chunk,0,$n);if($memory.Length -gt 5242880){throw 'input_limit'}}
 $memory.Position=0
 $decoder=[Windows.Media.Imaging.BitmapDecoder]::Create($memory,[Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat,[Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
 $frame=$decoder.Frames[0]
 if($frame.PixelWidth -lt 1 -or $frame.PixelHeight -lt 1 -or $frame.PixelWidth -gt 8192 -or $frame.PixelHeight -gt 8192 -or ([long]$frame.PixelWidth*$frame.PixelHeight) -gt 20000000){throw 'dimensions'}
 $scale=[Math]::Min(1,[Math]::Min(2048.0/$frame.PixelWidth,2048.0/$frame.PixelHeight))
 if($scale -lt 1){$frame=[Windows.Media.Imaging.TransformedBitmap]::new($frame,[Windows.Media.ScaleTransform]::new($scale,$scale))}
 $encoder=[Windows.Media.Imaging.PngBitmapEncoder]::new();$encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($frame))
 $output=[IO.MemoryStream]::new();$encoder.Save($output)
 if($output.Length -gt 5242880){throw 'output_limit'}
 $bytes=$output.ToArray();[Console]::OpenStandardOutput().Write($bytes,0,$bytes.Length)
 $output.Dispose();$memory.Dispose();exit 0
}catch{[Console]::Error.Write('FRAME_UNAVAILABLE');exit 2}
