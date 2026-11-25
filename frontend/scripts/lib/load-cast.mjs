// CPU skin tests use the shipped skeleton/geometry, without decoding textures.
import {readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
export async function loadCastGeometry(file) {
  const data=readFileSync(isAbsolute(file)&&!file.startsWith('/speaking/')?file:new URL('../../public'+file,import.meta.url));
  const n=data.readUInt32LE(12),j=JSON.parse(data.subarray(20,20+n));
  j.materials=j.materials.map(m=>({name:m.name}));delete j.textures;delete j.images;
  const raw=Buffer.from(JSON.stringify(j)),json=Buffer.alloc(Math.ceil(raw.length/4)*4,32);raw.copy(json);
  const bin=data.subarray(20+n),head=Buffer.from(data.subarray(0,20));head.writeUInt32LE(20+json.length+bin.length,8);head.writeUInt32LE(json.length,12);
  const bytes=Buffer.concat([head,json,bin]);
  return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
}
