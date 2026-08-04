"use client";

import {
  circle as createCircle,
  circleMarker as createCircleMarker,
  control,
  map as createMap,
  marker as createMarker,
  polygon as createPolygon,
  polyline as createPolyline,
  tileLayer as createTileLayer,
  type Evented,
  type FitBoundsOptions,
  type Icon,
  type DivIcon,
  type LatLngBoundsExpression,
  type LatLngExpression,
  type Layer as LeafletLayer,
  type LeafletEventHandlerFnMap,
  type Map as LeafletMap,
  type MapOptions,
  type Marker as LeafletMarker,
  type PathOptions,
  type PointExpression,
  type TileLayerOptions,
  type TooltipOptions,
} from "leaflet";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

type ControlPosition = "topleft" | "topright" | "bottomleft" | "bottomright";
type PolygonPositions = LatLngExpression[] | LatLngExpression[][] | LatLngExpression[][][];
type PolylinePositions = LatLngExpression[] | LatLngExpression[][];

const MapContext = createContext<LeafletMap | null>(null);
const LayerContext = createContext<LeafletLayer | null>(null);

export type MapContainerProps = {
  attributionControl?: boolean;
  bounds?: LatLngBoundsExpression;
  boundsOptions?: FitBoundsOptions;
  boxZoom?: boolean;
  center?: LatLngExpression;
  children?: ReactNode;
  className?: string;
  doubleClickZoom?: boolean;
  dragging?: boolean;
  keyboard?: boolean;
  scrollWheelZoom?: boolean;
  style?: CSSProperties;
  touchZoom?: MapOptions["touchZoom"];
  whenReady?: () => void;
  zoom?: number;
  zoomControl?: boolean;
};

export function MapContainer({
  attributionControl,
  bounds,
  boundsOptions,
  boxZoom,
  center,
  children,
  className,
  doubleClickZoom,
  dragging,
  keyboard,
  scrollWheelZoom,
  style,
  touchZoom,
  whenReady,
  zoom,
  zoomControl,
}: MapContainerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [mapInstance, setMapInstance] = useState<LeafletMap | null>(null);
  const readyRef = useRef(whenReady);
  useEffect(() => {
    readyRef.current = whenReady;
  }, [whenReady]);

  const initialViewRef = useRef<{
    bounds?: LatLngBoundsExpression;
    boundsOptions?: FitBoundsOptions;
    center?: LatLngExpression;
    zoom?: number;
  } | null>(null);
  if (initialViewRef.current === null) {
    initialViewRef.current = { bounds, boundsOptions, center, zoom };
  }

  const initialOptionsRef = useRef<MapOptions | null>(null);
  if (initialOptionsRef.current === null) {
    initialOptionsRef.current = definedOptions<MapOptions>({
      attributionControl,
      boxZoom,
      doubleClickZoom,
      dragging,
      keyboard,
      scrollWheelZoom,
      touchZoom,
      zoomControl,
    });
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = createMap(container, initialOptionsRef.current ?? undefined);
    const initialView = initialViewRef.current;
    map.whenReady(() => readyRef.current?.());
    if (initialView?.bounds) {
      map.fitBounds(initialView.bounds, initialView.boundsOptions);
    } else {
      map.setView(initialView?.center ?? [0, 0], initialView?.zoom ?? 0);
    }
    setMapInstance(map);

    return () => {
      setMapInstance((current) => current === map ? null : current);
      map.remove();
    };
  }, []);

  return (
    <div className={className} ref={containerRef} style={style}>
      {mapInstance ? <MapContext.Provider value={mapInstance}>{children}</MapContext.Provider> : null}
    </div>
  );
}

export function useMap() {
  const map = useContext(MapContext);
  if (!map) throw new Error("Leaflet map components must be rendered inside MapContainer.");
  return map;
}

export function useMapEvents(eventHandlers: LeafletEventHandlerFnMap) {
  const map = useMap();
  useEventHandlers(map, eventHandlers);
  return map;
}

type LayerHostProps = {
  children?: ReactNode;
  eventHandlers?: LeafletEventHandlerFnMap;
  layer: LeafletLayer;
};

function LayerHost({ children, eventHandlers, layer }: LayerHostProps) {
  const map = useMap();

  useEventHandlers(layer, eventHandlers);

  useEffect(() => {
    layer.addTo(map);
    return () => {
      if (map.hasLayer(layer)) map.removeLayer(layer);
    };
  }, [layer, map]);

  return <LayerContext.Provider value={layer}>{children}</LayerContext.Provider>;
}

function useEventHandlers(target: Evented, eventHandlers?: LeafletEventHandlerFnMap) {
  useEffect(() => {
    if (!eventHandlers) return;
    target.on(eventHandlers);
    return () => {
      target.off(eventHandlers);
    };
  }, [eventHandlers, target]);
}

export type TileLayerProps = {
  attribution?: string;
  eventHandlers?: LeafletEventHandlerFnMap;
  maxNativeZoom?: number;
  maxZoom?: number;
  url: string;
};

export function TileLayer({ attribution, eventHandlers, maxNativeZoom, maxZoom, url }: TileLayerProps) {
  const [layer] = useState(() => createTileLayer(url, definedOptions<TileLayerOptions>({
    attribution,
    maxNativeZoom,
    maxZoom,
  })));
  const previousPropsRef = useRef({ attribution, maxNativeZoom, maxZoom, url });

  useEffect(() => {
    const previous = previousPropsRef.current;
    const urlChanged = previous.url !== url;
    const optionsChanged = previous.attribution !== attribution
      || previous.maxNativeZoom !== maxNativeZoom
      || previous.maxZoom !== maxZoom;
    previousPropsRef.current = { attribution, maxNativeZoom, maxZoom, url };

    if (!urlChanged && !optionsChanged) return;
    if (urlChanged) layer.setUrl(url, true);
    if (optionsChanged) {
      Object.assign(layer.options, definedOptions<TileLayerOptions>({ attribution, maxNativeZoom, maxZoom }));
    }
    layer.redraw();
  }, [attribution, layer, maxNativeZoom, maxZoom, url]);

  return <LayerHost eventHandlers={eventHandlers} layer={layer} />;
}

type PathComponentProps = {
  children?: ReactNode;
  eventHandlers?: LeafletEventHandlerFnMap;
  interactive?: boolean;
  pathOptions?: PathOptions;
};

export type PolygonProps = PathComponentProps & {
  positions: PolygonPositions;
};

export function Polygon({ children, eventHandlers, interactive, pathOptions, positions }: PolygonProps) {
  const [layer] = useState(() => createPolygon(positions, withInteraction(pathOptions, interactive)));

  useEffect(() => {
    layer.setLatLngs(positions);
  }, [layer, positions]);
  usePathOptions(layer, pathOptions, interactive);

  return <LayerHost eventHandlers={eventHandlers} layer={layer}>{children}</LayerHost>;
}

export type PolylineProps = PathComponentProps & {
  positions: PolylinePositions;
};

export function Polyline({ children, eventHandlers, interactive, pathOptions, positions }: PolylineProps) {
  const [layer] = useState(() => createPolyline(positions, withInteraction(pathOptions, interactive)));

  useEffect(() => {
    layer.setLatLngs(positions);
  }, [layer, positions]);
  usePathOptions(layer, pathOptions, interactive);

  return <LayerHost eventHandlers={eventHandlers} layer={layer}>{children}</LayerHost>;
}

export type CircleProps = PathComponentProps & {
  center: LatLngExpression;
  radius: number;
};

export function Circle({ center, children, eventHandlers, interactive, pathOptions, radius }: CircleProps) {
  const [layer] = useState(() => createCircle(center, radius, withInteraction(pathOptions, interactive)));

  useEffect(() => {
    layer.setLatLng(center);
  }, [center, layer]);
  useEffect(() => {
    layer.setRadius(radius);
  }, [layer, radius]);
  usePathOptions(layer, pathOptions, interactive);

  return <LayerHost eventHandlers={eventHandlers} layer={layer}>{children}</LayerHost>;
}

export type CircleMarkerProps = PathComponentProps & {
  center: LatLngExpression;
  radius?: number;
};

export function CircleMarker({ center, children, eventHandlers, interactive, pathOptions, radius }: CircleMarkerProps) {
  const [layer] = useState(() => createCircleMarker(center, {
    ...withInteraction(pathOptions, interactive),
    ...(radius === undefined ? {} : { radius }),
  }));

  useEffect(() => {
    layer.setLatLng(center);
  }, [center, layer]);
  useEffect(() => {
    if (radius !== undefined) layer.setRadius(radius);
  }, [layer, radius]);
  usePathOptions(layer, pathOptions, interactive);

  return <LayerHost eventHandlers={eventHandlers} layer={layer}>{children}</LayerHost>;
}

export type MarkerProps = {
  children?: ReactNode;
  draggable?: boolean;
  eventHandlers?: LeafletEventHandlerFnMap;
  icon?: Icon | DivIcon;
  interactive?: boolean;
  position: LatLngExpression;
};

export function Marker({ children, draggable, eventHandlers, icon, interactive, position }: MarkerProps) {
  const [layer] = useState<LeafletMarker>(() => createMarker(position, definedOptions({
    draggable,
    icon,
    interactive,
  })));

  useEffect(() => {
    layer.setLatLng(position);
  }, [layer, position]);
  useEffect(() => {
    if (icon) layer.setIcon(icon);
  }, [icon, layer]);
  useEffect(() => {
    if (!layer.dragging) return;
    if (draggable) layer.dragging.enable();
    else layer.dragging.disable();
  }, [draggable, layer]);

  return <LayerHost eventHandlers={eventHandlers} layer={layer}>{children}</LayerHost>;
}

export type TooltipProps = {
  children?: ReactNode;
  className?: string;
  direction?: TooltipOptions["direction"];
  interactive?: boolean;
  offset?: PointExpression;
  opacity?: number;
  pane?: string;
  permanent?: boolean;
  sticky?: boolean;
};

export function Tooltip({
  children,
  className,
  direction,
  interactive,
  offset,
  opacity,
  pane,
  permanent,
  sticky,
}: TooltipProps) {
  const layer = useContext(LayerContext);
  const map = useMap();
  const [contentNode] = useState(() => document.createElement("div"));
  const options = useMemo(() => definedOptions<TooltipOptions>({
    className,
    direction,
    interactive,
    offset,
    opacity,
    pane,
    permanent,
    sticky,
  }), [className, direction, interactive, offset, opacity, pane, permanent, sticky]);

  if (!layer) throw new Error("Tooltip must be rendered inside a Leaflet layer component.");

  useEffect(() => {
    layer.bindTooltip(contentNode, options);
    if (permanent && map.hasLayer(layer)) layer.openTooltip();
    return () => {
      if (layer.getTooltip()?.getContent() === contentNode) layer.unbindTooltip();
    };
  }, [contentNode, layer, map, options, permanent]);

  useEffect(() => {
    const tooltip = layer.getTooltip();
    if (tooltip?.getContent() === contentNode && tooltip.isOpen()) tooltip.update();
  }, [children, contentNode, layer, options]);

  return createPortal(children, contentNode);
}

export type ScaleControlProps = {
  imperial?: boolean;
  maxWidth?: number;
  metric?: boolean;
  position?: ControlPosition;
  updateWhenIdle?: boolean;
};

export function ScaleControl(props: ScaleControlProps) {
  const map = useMap();
  const [instance] = useState(() => control.scale(props));

  useEffect(() => {
    instance.addTo(map);
    return () => {
      instance.remove();
    };
  }, [instance, map]);

  return null;
}

export type AttributionControlProps = {
  position?: ControlPosition;
  prefix?: string | false;
};

export function AttributionControl(props: AttributionControlProps) {
  const map = useMap();
  const [instance] = useState(() => control.attribution(props));

  useEffect(() => {
    instance.addTo(map);
    return () => {
      instance.remove();
    };
  }, [instance, map]);

  useEffect(() => {
    if (props.prefix !== undefined) instance.setPrefix(props.prefix);
  }, [instance, props.prefix]);

  return null;
}

function usePathOptions(
  layer: { options: PathOptions; setStyle(options: PathOptions): unknown },
  pathOptions: PathOptions | undefined,
  interactive: boolean | undefined,
) {
  useEffect(() => {
    const options = withInteraction(pathOptions, interactive);
    Object.assign(layer.options, options);
    layer.setStyle(options);
  }, [interactive, layer, pathOptions]);
}

function withInteraction(pathOptions: PathOptions | undefined, interactive: boolean | undefined) {
  return interactive === undefined
    ? { ...pathOptions }
    : { ...pathOptions, interactive };
}

function definedOptions<T extends object>(options: T): T {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as T;
}
