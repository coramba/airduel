// Shared plane geometry.
// Both the browser renderer and the authoritative server collision checks use
// the same local-coordinate model so visual tuning and gameplay tuning stay in
// one place.
export interface PlanePoint {
    x: number;
    y: number;
}

export interface PlaneSegment {
    start: PlanePoint;
    end: PlanePoint;
}

export interface PlaneEllipse {
    center: PlanePoint;
    radiusX: number;
    radiusY: number;
}

export interface PlaneCircle {
    center: PlanePoint;
    radius: number;
}

export interface PlaneGeometry {
    renderOffsetY: number;
    muzzlePoint: PlanePoint;
    fuselageTop: readonly PlanePoint[];
    fuselageBottom: readonly PlanePoint[];
    noseCap: readonly PlanePoint[];
    topWing: readonly PlanePoint[];
    bottomWing: readonly PlanePoint[];
    accentStripe: readonly PlanePoint[];
    tailFin: readonly PlanePoint[];
    tailWing: readonly PlanePoint[];
    cockpit: readonly PlanePoint[];
    struts: readonly PlaneSegment[];
    landingGear: readonly PlaneSegment[];
    propeller: PlaneEllipse;
    spinner: PlaneCircle;
    wheel: PlaneCircle;
    wheelHub: PlaneCircle;
    collisionPolygons: readonly (readonly PlanePoint[])[];
}

// Local points assume a right-facing aircraft profile centered around the
// shared plane state position.
export const PLANE_GEOMETRY: PlaneGeometry = {
    "renderOffsetY": -16,
    "muzzlePoint": {
        "x": 45,
        "y": -1
    },
    "fuselageTop": [
        {
            "x": -46,
            "y": -2
        },
        {
            "x": -10,
            "y": -8
        },
        {
            "x": 30,
            "y": -8
        },
        {
            "x": 38,
            "y": -6
        },
        {
            "x": 42,
            "y": -1
        },
        {
            "x": 35,
            "y": 10
        },
        {
            "x": 8,
            "y": 10
        },
        {
            "x": -20,
            "y": 4
        },
        {
            "x": -46,
            "y": 1
        }
    ],
    "fuselageBottom": [
        {
            "x": -40,
            "y": 2
        },
        {
            "x": -6,
            "y": 5
        },
        {
            "x": 35,
            "y": 5
        },
        {
            "x": 42,
            "y": 0
        },
        {
            "x": 36,
            "y": 11
        },
        {
            "x": -3,
            "y": 11
        },
        {
            "x": -25,
            "y": 8
        },
        {
            "x": -44,
            "y": 2
        }
    ],
    "noseCap": [
        {
            "x": -50,
            "y": -2
        },
        {
            "x": -43,
            "y": -8
        },
        {
            "x": -38,
            "y": -3
        },
        {
            "x": -43,
            "y": 3
        },
        {
            "x": -50,
            "y": 1
        }
    ],
    "topWing": [
        {
            "x": -2,
            "y": -22
        },
        {
            "x": 28,
            "y": -26
        },
        {
            "x": 34,
            "y": -24
        },
        {
            "x": 36,
            "y": -18
        },
        {
            "x": 30,
            "y": -14
        },
        {
            "x": -10,
            "y": -18
        }
    ],
    "bottomWing": [
        {
            "x": -4,
            "y": 11
        },
        {
            "x": 28,
            "y": 10
        },
        {
            "x": 35,
            "y": 6
        },
        {
            "x": 29,
            "y": 2
        },
        {
            "x": 2,
            "y": 3
        }
    ],
    "accentStripe": [
        {
            "x": -36,
            "y": -4
        },
        {
            "x": -20,
            "y": -4
        },
        {
            "x": -20,
            "y": -1
        },
        {
            "x": -36,
            "y": -1
        }
    ],
    "tailFin": [
        {
            "x": -44,
            "y": 2
        },
        {
            "x": -58,
            "y": -3
        },
        {
            "x": -55,
            "y": -14
        },
        {
            "x": -42,
            "y": -18
        },
        {
            "x": -37,
            "y": -4
        }
    ],
    "tailWing": [
        {
            "x": -46,
            "y": 0
        },
        {
            "x": -58,
            "y": 5
        },
        {
            "x": -48,
            "y": 6
        },
        {
            "x": -38,
            "y": 2
        }
    ],
    "cockpit": [
        {
            "x": -12,
            "y": -8
        },
        {
            "x": -9,
            "y": -12
        },
        {
            "x": -3,
            "y": -12
        },
        {
            "x": 1,
            "y": -8
        },
        {
            "x": -3,
            "y": -6
        },
        {
            "x": -9,
            "y": -6
        }
    ],
    "struts": [
        {
            "start": {
                "x": 3,
                "y": -17
            },
            "end": {
                "x": 10,
                "y": 5
            }
        },
        {
            "start": {
                "x": 28,
                "y": -15
            },
            "end": {
                "x": 26,
                "y": 5
            }
        }
    ],
    "landingGear": [
        {
            "start": {
                "x": 12,
                "y": 10
            },
            "end": {
                "x": 19,
                "y": 20
            }
        },
        {
            "start": {
                "x": 26,
                "y": 10
            },
            "end": {
                "x": 23,
                "y": 20
            }
        }
    ],
    "propeller": {
        "center": {
            "x": 45,
            "y": -1
        },
        "radiusX": 2.8,
        "radiusY": 23
    },
    "spinner": {
        "center": {
            "x": 44,
            "y": -1
        },
        "radius": 4.5
    },
    "wheel": {
        "center": {
            "x": 21,
            "y": 22
        },
        "radius": 8.5
    },
    "wheelHub": {
        "center": {
            "x": 21,
            "y": 22
        },
        "radius": 4.5
    },
    "collisionPolygons": [
        [
            {
                "x": -57,
                "y": -8
            },
            {
                "x": -50,
                "y": -18
            },
            {
                "x": -43,
                "y": -18
            },
            {
                "x": -38,
                "y": -8
            },
            {
                "x": 34,
                "y": -12
            },
            {
                "x": 42,
                "y": 0
            },
            {
                "x": 34,
                "y": 10
            },
            {
                "x": -20,
                "y": 8
            },
            {
                "x": -58,
                "y": 0
            }
        ],
        [
            {
                "x": -10,
                "y": -18
            },
            {
                "x": 38,
                "y": -18
            },
            {
                "x": 33,
                "y": -8
            },
            {
                "x": -8,
                "y": -8
            }
        ],
        [
            {
                "x": 0,
                "y": 2
            },
            {
                "x": 34,
                "y": 3
            },
            {
                "x": 30,
                "y": 11
            },
            {
                "x": -4,
                "y": 10
            }
        ],
        [
            {
                "x": -58,
                "y": -14
            },
            {
                "x": -42,
                "y": -5
            },
            {
                "x": -42,
                "y": 3
            },
            {
                "x": -58,
                "y": 5
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
