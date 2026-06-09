# Test diretto stampante 192.168.1.102
# Lancio: irm https://raw.githubusercontent.com/jeanpaulnarvaez8-dev/gustopro-print-agent/main/test-102.ps1 | iex

Write-Host ""
Write-Host "=== TEST DIRETTO STAMPANTE 192.168.1.102:9100 ===" -ForegroundColor Cyan
Write-Host ""

try {
    Write-Host "Connessione TCP a 192.168.1.102:9100..." -ForegroundColor Yellow
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.ReceiveTimeout = 3000
    $tcp.SendTimeout = 3000
    $tcp.Connect("192.168.1.102", 9100)
    Write-Host "  ✓ Connesso" -ForegroundColor Green

    $stream = $tcp.GetStream()
    $text = "`n`n=== TEST DIRETTO ===`n`nStampante 192.168.1.102`nFunziona OK`n`n`n`n"
    $bytes = [byte[]](0x1B, 0x40) + [System.Text.Encoding]::ASCII.GetBytes($text) + [byte[]](0x1B, 0x64, 0x03, 0x1D, 0x56, 0x01)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
    Start-Sleep -Milliseconds 500
    $tcp.Close()

    Write-Host "  ✓ Inviati $($bytes.Length) byte (init + testo + taglio)" -ForegroundColor Green
    Write-Host ""
    Write-Host "Vai a vedere la stampante 192.168.1.102:" -ForegroundColor Cyan
    Write-Host "  - Se esce un foglietto 'TEST DIRETTO' → STAMPANTE OK ✓" -ForegroundColor Green
    Write-Host "  - Se non esce nulla → controlla carta / spie / coperchio" -ForegroundColor Yellow
} catch {
    Write-Host "  ✗ ERRORE: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "Possibili cause:" -ForegroundColor Yellow
    Write-Host "  - Stampante spenta" -ForegroundColor Yellow
    Write-Host "  - Cavo Ethernet staccato" -ForegroundColor Yellow
    Write-Host "  - IP cambiato (rilancia lo scan)" -ForegroundColor Yellow
}
Write-Host ""
