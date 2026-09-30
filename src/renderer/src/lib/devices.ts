export interface Option {
  value: string
  label: string
}

/** 第一项是空值，代表系统默认设备 */
export function deviceOptions(devices: MediaDeviceInfo[], defaultLabel: string): Option[] {
  return [
    { value: '', label: defaultLabel },
    ...devices.map((device, index) => ({
      value: device.deviceId,
      label: device.label || `设备 ${index + 1}`
    }))
  ]
}

// 只认会议里常用的虚拟声卡；乐播投屏这类「Cast Audio (Virtual)」不是给会议软件当麦克风用的
const VIRTUAL_DEVICE = /blackhole|vb-audio|cable (input|output)|loopback audio|soundflower/i

export function hasVirtualDevice(devices: MediaDeviceInfo[]): boolean {
  return devices.some((device) => VIRTUAL_DEVICE.test(device.label))
}

export function shortcutLabel(platform: string): string {
  return platform === 'darwin' ? '⌘⇧Space' : 'Ctrl+Shift+Space'
}
