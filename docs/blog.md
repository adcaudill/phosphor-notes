---
title: Blog
layout: page
permalink: /blog/
---

Updates and announcements about the Phosphor Notes project.

{% if site.posts.size > 0 %}

<div class="blog-archive">
  {% for post in site.posts %}
  <div class="blog-post-item">
    <div class="blog-post-title">
      <a href="{{ post.url }}">{{ post.title }}</a>
    </div>
    <div class="blog-post-meta">
      <span class="post-date">{{ post.date | date: "%B %d, %Y" }}</span>
      {% if post.author %}
      <span class="post-author"> • By {{ post.author }}</span>
      {% endif %}
    </div>
    {% if post.excerpt %}
    <div class="blog-post-excerpt">
      {{ post.excerpt | strip_html | truncatewords: 50 }}
    </div>
    {% endif %}
  </div>
  {% endfor %}
</div>

{% else %}

<p>No blog posts yet. Check back soon!</p>

{% endif %}
