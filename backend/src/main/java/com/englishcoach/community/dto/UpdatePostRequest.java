package com.englishcoach.community.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class UpdatePostRequest {

    @NotBlank(message = "Nội dung bài viết không được để trống")
    @Size(max = 10000, message = "Nội dung bài viết tối đa 10,000 ký tự")
    private String content;

    @Size(max = 12, message = "Tối đa 12 tệp đính kèm (tối đa 10 ảnh và 2 video)")
    private List<Long> mediaIds;

    @Size(max = 12, message = "Tối đa 12 tệp đính kèm (tối đa 10 ảnh và 2 video)")
    private List<String> mediaUrls;
}
