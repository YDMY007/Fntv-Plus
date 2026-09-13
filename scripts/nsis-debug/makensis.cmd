@echo off
powershell -NoProfile -Command "$input | Set-Content -Encoding UTF8 ('C:\Users\24305\AppData\Local\Temp\nsis-capture-' + $PID + '.nsi')"
"C:\Users\24305\AppData\Local\electron-builder\Cache\nsis-3.0.4.1\nsis-3.0.4.1-1mx3n\Bin\makensis.exe" -INPUTCHARSET UTF8 ("C:\Users\24305\AppData\Local\Temp\nsis-capture-" + 0 + ".nsi") %*
