// Shared plane geometry.
// Collision polygons are the authoritative hitboxes used by both the server
// simulation and the client debug overlay. Visual rendering uses PNG images.
export interface PlanePoint {
    x: number;
    y: number;
}

export interface PlaneGeometry {
    renderOffsetY: number;
    // Pixel offset within the plane PNG where the local origin (0,0) sits.
    // Adjust this to align the image with the physics position.
    imagePivot?: PlanePoint;
    muzzlePoint: PlanePoint;
    collisionPolygons: readonly (readonly PlanePoint[])[];
}

export const PLANE_GEOMETRY: PlaneGeometry = {
    "renderOffsetY": -16,
    "imagePivot": {"x": 42, "y": 20},
    "muzzlePoint": {"x": 30, "y": -1},
    "collisionPolygons": [
        [
            {
                "x": 30,
                "y": 0
            },
            {
                "x": 20,
                "y": -10
            },
            {
                "x": -5,
                "y": -8
            },
            {
                "x": -25,
                "y": 0
            },
            {
                "x": -30,
                "y": -10
            },
            {
                "x": -40,
                "y": -10
            },
            {
                "x": -40,
                "y": 10
            },
            {
                "x": 20,
                "y": 10
            }
        ]
    ]
};

export function getPlaneShapeOrigin(
    position: PlanePoint,
    geometry: PlaneGeometry = PLANE_GEOMETRY
): PlanePoint {
    return {
        x: position.x,
        y: position.y + geometry.renderOffsetY
    };
}

export function transformPlanePoint(
    point: PlanePoint,
    origin: PlanePoint,
    angle: number
): PlanePoint {
    const cosAngle = Math.cos(angle);
    const sinAngle = Math.sin(angle);

    return {
        x: origin.x + point.x * cosAngle - point.y * sinAngle,
        y: origin.y + point.x * sinAngle + point.y * cosAngle
    };
}

export function transformPlanePolygon(
    points: readonly PlanePoint[],
    origin: PlanePoint,
    angle: number
): PlanePoint[] {
    return points.map((point) => transformPlanePoint(point, origin, angle));
}
