# Bản Đồ Chiến Lược Nuance (Nuance Strategy Map)

```mermaid
graph TD
    %% Styling
    classDef core fill:#000,stroke:#fff,stroke-width:4px,color:#fff;
    classDef hardware fill:#2d2d2d,stroke:#999,stroke-width:2px,color:#fff;
    classDef software fill:#1a1a1a,stroke:#666,stroke-width:2px,color:#fff;
    classDef business fill:#333,stroke:#fff,stroke-dasharray: 5 5,color:#fff;

    Center[NUANCE<br/>Democratizing Perfection]:::core

    subgraph HARDWARE ["THE NUANCE SHELL (Phần Cứng)"]
        H1[Vỏ In 3D Ergonomic]:::hardware
        H2[Dòng 'Haiku'<br/>(Nhám, Phác thảo)]:::hardware
        H3[Dòng 'Flow'<br/>(Mịn, Viết nhanh)]:::hardware
        
        H1 --> H2 & H3
    end

    subgraph ENGINE ["THE NUANCE ENGINE (Phần Mềm)"]
        S1[Vật Lý Cảm Giác<br/>(Sensory Physics)]:::software
        S2[Người Hộ Vệ Dòng Chảy<br/>(Flow Guardian)]:::software
        S3[Mực Ngữ Nghĩa<br/>(Semantic Ink)]:::software
        
        S1 -->|ASMR + Ma sát ảo| S1a[Cảm giác Thật]:::software
        S2 -->|AI Palm Rejection| S2a[Sự Tập Trung]:::software
        S3 -->|Shadow Indexing| S3a[Tri Thức]:::software
    end

    subgraph ECOSYSTEM ["THE MOAT (Hệ Sinh Thái)"]
        B1[Cân Chỉnh Sinh Trắc Học]:::business
        B2[Cộng Đồng Profile]:::business
        B3[Dữ Liệu Cơ Học Tay]:::business
    end

    %% Connections
    Center --> HARDWARE
    Center --> ENGINE
    Center --> ECOSYSTEM

    H2 -.->|QR Code / Nhận diện| S1
    H3 -.->|QR Code / Nhận diện| S1

    S1 & S2 & S3 --> B1
    B1 --> B3
    B2 --> B3
```

## Giải Thích
Sơ đồ trên thể hiện mối quan hệ cộng sinh giữa Phần cứng (Vỏ bút) và Phần mềm (Engine).
- **Trái tim:** Nuance - Bình dân hóa sự hoàn hảo.
- **Phần cứng:** Là chìa khóa vật lý (Vỏ Haiku/Flow) để mở khóa trải nghiệm.
- **Phần mềm:** Là bộ não xử lý cảm giác và bảo vệ sự tập trung.
- **Hệ sinh thái:** Là con hào bảo vệ (Dữ liệu người dùng và Cộng đồng).
