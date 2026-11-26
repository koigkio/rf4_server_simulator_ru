//go:build windows

package main

import "golang.org/x/sys/windows/registry"

// steamExeFromRegistry читает путь к steam.exe, который клиент Steam
// записывает в HKCU\Software\Valve\Steam (SteamExe).
func steamExeFromRegistry() string {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Valve\Steam`, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	if v, _, err := k.GetStringValue("SteamExe"); err == nil && v != "" {
		return v
	}
	if v, _, err := k.GetStringValue("SteamPath"); err == nil && v != "" {
		return v + "/steam.exe"
	}
	return ""
}
