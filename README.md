# GustoPro Print Agent

Agente di stampa locale per il gestionale GustoPro. Fa polling al backend
cloud e relaya i job verso le stampanti termiche ESC/POS in LAN.

## Installazione su Windows (PC sempre acceso al ristorante)

Apri **PowerShell come Amministratore** ed esegui:

```powershell
$env:PRINT_AGENT_TOKEN = "il_token_segreto_che_ti_ha_dato_jp"
irm https://raw.githubusercontent.com/jeanpaulnarvaez8-dev/gustopro-print-agent/main/install.ps1 | iex
```

L'installer:
- Verifica/installa Node.js LTS
- Crea `C:\GustoPro\agent\`
- Scarica `agent.js` e `package.json`
- Scarica NSSM per gestire il servizio Windows
- Crea il servizio `GustoProPrintAgent` con avvio automatico al boot
- Lo avvia subito

## Disinstallazione

```powershell
irm https://raw.githubusercontent.com/jeanpaulnarvaez8-dev/gustopro-print-agent/main/uninstall.ps1 | iex
```

## Variabili d'ambiente

| Var | Default | Descrizione |
|---|---|---|
| `PRINT_AGENT_TOKEN` | — (obbligatorio) | Token statico per autenticarsi al backend |
| `CLOUD_BASE` | `https://gestione.gustopro.it/api` | Backend cloud |
| `TENANT_SLUG` | `riva-beach` | Slug del tenant da cui drenare la coda |
| `POLL_SECONDS` | `2` | Intervallo polling |
| `PRINTER_IP` | `192.168.1.24` | Stampante preconto (POS80D) |
| `KITCHEN_PRINTER_IP` | `192.168.1.23` | Stampante cucina |
| `BAR_PRINTER_IP` | `192.168.1.21` | Stampante bar |
| `FISCAL_PRINTER_IP` | (vuoto) | Cassa fiscale RT (lasciato vuoto fino a configurazione) |

## Verifica funzionamento

Dal PC Windows:

```powershell
Get-Service GustoProPrintAgent
Get-Content C:\GustoPro\agent\logs\agent.log -Wait -Tail 20
```

## Comandi utili

```powershell
Restart-Service GustoProPrintAgent
Stop-Service GustoProPrintAgent
Start-Service GustoProPrintAgent
```
