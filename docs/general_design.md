# General Design

This document describes the conceptual design of ZoneTracker for technical readers of this repository. It explains architecture, responsibilities, and data flow at a high level; it does not define a formal implementation specification.

ZoneTracker is a web-based GPS activity tracker. During an active session, the application periodically captures geolocation data and related metadata for later analysis and visualization.

## Purpose and Scope

The system is designed to:
- Start and stop activity tracking through a simple web interface.
- Capture location samples using browser geolocation capabilities.
- Store data locally during collection to support intermittent connectivity.
- Persist completed activities to a back-end service.
- Provide tools to review and compare recorded activities.

## System Overview

ZoneTracker uses a Vue single-page application as the primary client. The browser is responsible for data collection and temporary storage, while back-end services provide durable storage and post-processing.

## Conceptual Boundaries

In scope:
- High-level component responsibilities.
- Primary data lifecycle from collection to visualization.
- Reliability and operational concerns that shape the architecture.

Out of scope:
- API contracts, database schemas, and wire formats.
- Exact sampling frequencies and policy thresholds.
- Deployment, scaling, and infrastructure topology details.

## Core Design Components

### 1. Activity Control
- User actions initiate and end tracking sessions.
- Session state is explicit and visible in the UI.

### 2. Location Collection
- The client collects periodic GPS samples through HTML5 Geolocation APIs.
- Each sample may include latitude, longitude, altitude, speed, heading, timestamp, and accuracy values when available.

### 3. Background and Offline Behavior
- Service Workers support resilient behavior during active sessions.
- IndexedDB is used for local caching of samples and session metadata.
- Collection and local persistence continue even when network access is limited.

### 4. Data Synchronization
- After an activity completes, locally stored data is uploaded to back-end endpoints.
- Synchronization is modeled as idempotent and resilient to transient failures.

### 5. Visualization and Analysis
- The application provides visual representations of routes and activity metrics.
- Users can compare activities and inspect session details.

## Architectural Qualities

- Reliability: The collection path prioritizes data durability during capture and upload.
- Performance: The UI remains responsive during extended tracking sessions.
- Security: Location data is protected in transit and at rest.
- Maintainability: Collection, storage, synchronization, and presentation remain clearly separated.
    