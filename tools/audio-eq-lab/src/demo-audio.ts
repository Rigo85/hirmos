export function createTechnicalDemo(): File {
  const sampleRate = 44_100;
  const durationSeconds = 18;
  const samples = sampleRate * durationSeconds;
  const left = new Float32Array(samples);
  const right = new Float32Array(samples);

  for (let index = 0; index < samples; index += 1) {
    const time = index / sampleRate;
    const section = Math.floor(time / 6);
    const envelope = Math.min(1, (time % 6) * 3, (6 - (time % 6)) * 3);
    const bassGain = section === 1 ? 0.58 : 0.25;
    const presenceGain = section === 2 ? 0.35 : 0.13;
    const sample = envelope * (
      bassGain * Math.sin(2 * Math.PI * 110 * time)
      + 0.18 * Math.sin(2 * Math.PI * 440 * time)
      + presenceGain * Math.sin(2 * Math.PI * 3500 * time)
      + 0.07 * Math.sin(2 * Math.PI * 8000 * time)
    );
    left[index] = Math.max(-0.97, Math.min(0.97, sample));
    right[index] = Math.max(-0.97, Math.min(0.97, sample * 0.96));
  }

  for (const time of [4.2, 10.4, 15.1]) {
    const position = Math.floor(time * sampleRate);
    left[position] = 0.99;
    right[position] = 0.99;
  }

  const wav = encodeWave([left, right], sampleRate);
  return new File([wav], 'señal-técnica-hirmos.wav', { type: 'audio/wav' });
}

function encodeWave(channels: readonly Float32Array[], sampleRate: number): ArrayBuffer {
  const channelCount = channels.length;
  const sampleCount = channels[0]?.length ?? 0;
  const bytesPerSample = 2;
  const dataLength = sampleCount * channelCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  writeText(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeText(view, 8, 'WAVE');
  writeText(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeText(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let index = 0; index < sampleCount; index += 1) {
    for (const channel of channels) {
      const sample = Math.max(-1, Math.min(1, channel[index] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }
  return buffer;
}

function writeText(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
