declare module "shpjs" {
  type ShapefileParts = {
    shp: ArrayBuffer | ArrayBufferView;
    dbf?: ArrayBuffer | ArrayBufferView;
    prj: string;
    cpg?: string;
  };

  export default function getShapefile(input: ShapefileParts): Promise<unknown>;
}
