import sharp from 'sharp';
import { ACQUISITION_POLICY } from '../worker/acquisition-policy.js';

// Match the Images binding used by the shared media pipeline; re-encoding strips metadata.
export const localImages = {
  input(stream) {
    return {transform(options) { return {async output(output) {
      const bytes = Buffer.from(await new Response(stream).arrayBuffer());
      const transformed = await sharp(bytes,{animated:false,limitInputPixels:ACQUISITION_POLICY.pixels,failOn:'warning'})
        .resize({width:options.width,height:options.height,fit:'inside',withoutEnlargement:true})
        .webp({quality:output.quality}).toBuffer();
      return {response() { return new Response(transformed,{headers:{'content-type':'image/webp'}}); }};
    }}; }};
  },
};
