// Shared plane geometry data and transform helpers.
// Type definitions (PlanePoint, PlaneGeometry) live in src/types/geometry.ts.
// Collision polygons are the authoritative hitboxes used by both the server
// simulation and the client debug overlay. Visual rendering uses PNG images.
import type { PlaneGeometry, PlanePoint } from '../types/geometry.js';

export const PLANE_GEOMETRY: PlaneGeometry = {
    "renderOffsetY": -16,
    "imagePivot": {"x": 52, "y": 10},
    "muzzlePoint": {"x": 10, "y": 10},
    "collisionPolygons": [
        [
            { "x": 20,  "y": 10 },
            { "x": 10,  "y": 0  },
            { "x": -15, "y": 2  },
            { "x": -35, "y": 10 },
            { "x": -40, "y": 0  },
            { "x": -50, "y": 0  },
            { "x": -50, "y": 20 },
            { "x": 10,  "y": 20 }
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
