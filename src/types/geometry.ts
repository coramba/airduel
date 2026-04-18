export interface PlanePoint {
  x: number;
  y: number;
}

export interface PlaneGeometry {
  renderOffsetY: number;
  imagePivot?: PlanePoint;
  muzzlePoint: PlanePoint;
  collisionPolygons: readonly (readonly PlanePoint[])[];
}
